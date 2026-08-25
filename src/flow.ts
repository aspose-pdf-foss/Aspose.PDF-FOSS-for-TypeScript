import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import { FloatingBox } from './floatbox.js';
import {
  flowTextBlock, stampText, measureText, measureTextBlock,
  type TextBlockOptions, type StampOptions, type AuthoringFont,
} from './stamp.js';
import {
  validateDecoration, validateBackground, resolveDecor, decorRects, vmetricsFor, isTextRunList,
  type Decoration, type Background, type TextRun,
} from './textdecor.js';
import { buildImageXObject, drawBuiltImage, type BuiltImage } from './imageembed.js';
import { num, appendContent, wrapMarkedContent } from './pagecontent.js';
import { allocContentMcid } from './structwrite.js';
import { enc } from './serialize.js';
import { PageFormat } from './pageformat.js';
import {
  clearTo, insetsAt, nextBoundary, pruneFloats, resolveFloatTop,
  type ActiveFloat,
} from './floatstack.js';
import {
  nonNegative, normalizeClear, normalizeSpacing,
  type FlowClear, type FlowElement, type MeasureContext, type PlaceContext, type PlaceResult,
} from './flowelement.js';

import {
  rule, codeBlock, quote,
  type FlowRuleOptions, type FlowCodeOptions, type FlowQuoteOptions,
} from './flowblock.js';
import { table, type FlowTableOptions } from './flowtable.js';
import type { TableBuilder } from './tableauthor.js';
import { markdownElements, type MarkdownFlowOptions, type MarkdownResult } from './mdflow.js';
import type { MdDocument } from './mdast.js';

export type {
  FlowClear, FlowElement, MeasureContext, PlaceContext, PlaceResult,
} from './flowelement.js';

export { rule, codeBlock, quote } from './flowblock.js';
export type {
  FlowRuleOptions, FlowCodeOptions, FlowQuoteOptions, FlowQuoteBar,
} from './flowblock.js';

export { table } from './flowtable.js';
export type { FlowTableOptions } from './flowtable.js';

export { PageFormat } from './pageformat.js';

/** Options for {@link Document.NewFlow}. All lengths are in points. */
export interface FlowOptions {
  /** Page size for every page the flow creates. Default {@link PageFormat.A4}. */
  format?: PageFormat;
  /** Number of columns. Integer >= 1. Default 1. */
  columns?: number;
  /** Gutter between columns. >= 0. Default 0. */
  columnGap?: number;
  /** Left page margin. >= 0. Default 72. */
  marginLeft?: number;
  /** Right page margin. >= 0. Default 72. */
  marginRight?: number;
  /** Top page margin. >= 0. Default 72. */
  marginTop?: number;
  /** Bottom page margin. >= 0. Default 72. */
  marginBottom?: number;
  /** Vertical gap inserted between consecutive elements in a column. >= 0.
   *  Default 0. Dropped at a column top. */
  paragraphSpacing?: number;
  /** Emit logical structure (`/H1`..`/H6`, `/P`) into the document structure tree
   *  on Render. Default false (output is byte-identical to an untagged flow). */
  tagged?: boolean;
  /** Natural language of this flow's content, as a BCP 47 tag (e.g. 'en-US'),
   *  written to the `/Sect` the flow creates. Requires `tagged: true`.
   *
   *  It goes on the flow's own element rather than the document catalog so two
   *  flows in different languages can share one document, and so appending a
   *  flow to an existing document cannot relabel that document's language.
   *  `StructElement.EffectiveLang` walks ancestors before falling back to
   *  {@link Document.Lang}, so this satisfies PDF/UA's natural-language
   *  requirement for exactly the content this flow adds. */
  lang?: string;
  /** Push a heading to the next column when the following element cannot place at
   *  least one line beneath it in the current column. Default true. Overridable
   *  per heading via {@link FlowHeadingOptions.keepWithNext}. */
  keepHeadingsWithNext?: boolean;
}

/** Resolved, validated flow geometry (identical on every page). @internal */
export interface Geometry {
  format: PageFormat;
  columns: number;
  columnGap: number;
  paragraphSpacing: number;
  contentLeft: number;
  contentTop: number;
  contentBottom: number;
  columnWidth: number;
  columnHeight: number;
}

/** Validate `options` and derive the page/column geometry. @internal */
export function normalizeFlowOptions(options: FlowOptions = {}): Geometry {
  const format = options.format ?? PageFormat.A4;
  if (!(format instanceof PageFormat)) throw new TypeError('format must be a PageFormat');
  const columns = options.columns ?? 1;
  if (!Number.isInteger(columns) || columns < 1)
    throw new TypeError('columns must be an integer >= 1');
  const columnGap = nonNegative(options.columnGap, 0, 'columnGap');
  const marginLeft = nonNegative(options.marginLeft, 72, 'marginLeft');
  const marginRight = nonNegative(options.marginRight, 72, 'marginRight');
  const marginTop = nonNegative(options.marginTop, 72, 'marginTop');
  const marginBottom = nonNegative(options.marginBottom, 72, 'marginBottom');
  const paragraphSpacing = nonNegative(options.paragraphSpacing, 0, 'paragraphSpacing');

  const contentLeft = marginLeft;
  const contentTop = format.height - marginTop;
  const contentBottom = marginBottom;
  const contentWidth = format.width - marginLeft - marginRight;
  const columnWidth = (contentWidth - (columns - 1) * columnGap) / columns;
  const columnHeight = contentTop - contentBottom;
  if (columnWidth <= 0)
    throw new TypeError('flow columnWidth must be positive (reduce margins, columns, or columnGap)');
  if (columnHeight <= 0)
    throw new TypeError('flow column height must be positive (reduce top/bottom margins)');

  return {
    format, columns, columnGap, paragraphSpacing,
    contentLeft, contentTop, contentBottom, columnWidth, columnHeight,
  };
}

/** Left edge (PDF user space) of column `col` (0-based). @internal */
export function columnX(g: Geometry, col: number): number {
  return g.contentLeft + col * (g.columnWidth + g.columnGap);
}

/** Flowed text: a plain string, or a {@link TextRun} list mixing styles within
 *  one wrapped block. */
export type FlowText = string | TextRun[];

/** Whether flowed text would draw nothing — which decides whether an element
 *  ever gets a structure node. */
function isEmptyFlowText(t: FlowText): boolean {
  return isTextRunList(t) ? t.every((r) => r.text.length === 0) : t.length === 0;
}

/** The three helpers below each have two identical arms. TypeScript resolves an
 *  overloaded call by picking one signature, and a `string | TextRun[]` argument
 *  matches neither; narrowing first is what lets each arm pick its own. Wrapping
 *  them here keeps that shape in one place rather than at four call sites. */
function measureFlowText(
  t: FlowText, width: number, availHeight: number, o: TextBlockOptions,
): { usedHeight: number; remainder: FlowText | null } {
  return isTextRunList(t)
    ? measureTextBlock(t, width, availHeight, o)
    : measureTextBlock(t, width, availHeight, o);
}

function drawFlowText(
  doc: Document, page: Page, t: FlowText,
  rect: [number, number, number, number], o: TextBlockOptions,
): { remainder: FlowText | null; usedHeight: number } {
  return isTextRunList(t)
    ? flowTextBlock(doc, page, t, rect, o)
    : flowTextBlock(doc, page, t, rect, o);
}

/** Typographic options for {@link Flow.AddParagraph} (a subset of the text-block
 *  options; flow content is always laid top-down, so `valign` is not offered). */
export interface FlowParagraphOptions {
  font?: AuthoringFont;
  fontSize?: number;
  color?: [number, number, number];
  align?: 'left' | 'center' | 'right' | 'justify';
  leading?: number;
  /** Rule below the baseline of every line. Default: none. */
  underline?: Decoration;
  /** Rule through the glyphs of every line. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind each line's text. Default: none. */
  background?: Background;
  /** Points inserted above this element (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below this element (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop this element below the floats on the given side(s) before placing it.
   *  Default: none. */
  clear?: FlowClear;
}

/** Options for {@link Flow.AddHeading}. Extends {@link FlowParagraphOptions}; the
 *  heading `level` (1..6) is the positional argument, not an option. */
export interface FlowHeadingOptions extends FlowParagraphOptions {
  /** Override the flow's {@link FlowOptions.keepHeadingsWithNext} policy for this
   *  heading. `undefined` inherits the flow default (true). */
  keepWithNext?: boolean;
}

/** Default font size (points) for heading levels 1..6 when `fontSize` is unset. */
const HEADING_SIZES = [24, 18, 14, 12, 10, 8];

function paragraphOptions(o: FlowParagraphOptions): TextBlockOptions {
  return {
    font: o.font, fontSize: o.fontSize, color: o.color, align: o.align, leading: o.leading,
    underline: o.underline, strikethrough: o.strikethrough, background: o.background,
  };
}

/** A word-wrapped text element (paragraph or heading) flowed through
 *  {@link flowTextBlock}. `structType` (`'P'`, `'H1'`..`'H6'`) and `tag` drive
 *  logical-structure tagging when the flow is tagged. @internal */
class TextElement implements FlowElement {
  constructor(
    private readonly text: FlowText,
    private readonly opts: TextBlockOptions,
    private readonly structType: string,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    private tag?: StructElement,
    readonly keepWithNextEligible: boolean = false,
    readonly keepWithNext?: boolean,
    readonly clear?: FlowClear,
  ) {}

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const { usedHeight, remainder } = measureFlowText(this.text, ctx.width, ctx.availHeight, this.opts);
    return { usedHeight, fits: remainder === null && usedHeight > 0 };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    // First placement of non-empty text under a tagged flow: create this element's
    // /Hn or /P node in reading order. Empty text draws nothing, so it never tags
    // (no orphan). flowTextBlock only allocates an MCID when a line actually paints,
    // so an overflow probe that draws nothing here leaves the node childless until
    // it draws in the next column.
    if (this.tag === undefined && ctx.structParent && !isEmptyFlowText(this.text)) {
      this.tag = ctx.structParent.Append(this.structType);
    }
    const opts = this.tag ? { ...this.opts, tag: this.tag } : this.opts;
    const rect: [number, number, number, number] =
      [ctx.x, ctx.top - ctx.availHeight, ctx.width, ctx.availHeight];
    const { remainder, usedHeight } = drawFlowText(ctx.doc, ctx.page, this.text, rect, opts);
    if (usedHeight === 0) {
      // Nothing drawn: null remainder = empty/undrawable (discard); else it did
      // not fit in the leftover space (retry this element in the next column).
      return { usedHeight: 0, remainder: remainder === null ? null : this, drew: false };
    }
    return {
      usedHeight,
      // Continuation carries spaceBefore = 0 (already started) and the same tag.
      remainder: remainder === null ? null
        : new TextElement(remainder, this.opts, this.structType, 0, this.spaceAfter, this.tag),
      drew: true,
    };
  }
}

/** Build a word-wrapped paragraph element. The builder behind
 *  {@link Flow.AddParagraph}; use it to compose the `blocks` of a list item or
 *  the contents of a block quote. */
export function paragraph(text: FlowText, o: FlowParagraphOptions = {}): FlowElement[] {
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  return [new TextElement(text, paragraphOptions(o), 'P', spaceBefore, spaceAfter,
    undefined, false, undefined, normalizeClear(o.clear))];
}

/** Build a word-wrapped heading element. `level` is an integer 1..6, driving a
 *  default font size (24/18/14/12/10/8) and a Helvetica-Bold default, both
 *  overridable, and (when the flow is tagged) the `/H1`..`/H6` structure type.
 *  The builder behind {@link Flow.AddHeading}. */
export function heading(level: number, text: FlowText, o: FlowHeadingOptions = {}): FlowElement[] {
  if (!Number.isInteger(level) || level < 1 || level > 6)
    throw new TypeError('heading level must be an integer in 1..6');
  if (o.keepWithNext !== undefined && typeof o.keepWithNext !== 'boolean')
    throw new TypeError('keepWithNext must be a boolean');
  const withDefaults: FlowParagraphOptions = {
    ...o,
    font: o.font ?? 'Helvetica-Bold',
    fontSize: o.fontSize ?? HEADING_SIZES[level - 1],
  };
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  return [new TextElement(text, paragraphOptions(withDefaults), 'H' + String(level),
    spaceBefore, spaceAfter, undefined, true, o.keepWithNext, normalizeClear(o.clear))];
}

/** k constant for a 4-Bézier circle approximation (mirrors graphics.ts). */
const KAPPA = 0.5522847498307936;
/** Vector-bullet cycle by depth: filled disc, hollow ring, filled square. */
const BULLET_SHAPES = ['disc', 'ring', 'square'] as const;
const BULLET_GLYPHS = ['•', '◦', '▪'];

/** The two task-list markers, drawn as vector geometry because WinAnsi has no
 *  ballot-box glyph and there is no substitute face to fall back on. */
const CHECK_SHAPES = ['checkbox', 'checked'] as const;
/** Every vector marker shape. @internal */
type MarkerShape = (typeof BULLET_SHAPES)[number] | (typeof CHECK_SHAPES)[number];
const isCheckShape = (s: MarkerShape): boolean => s === 'checkbox' || s === 'checked';

/** A resolved list marker: an ordinal / explicit-bullet text glyph, or a vector
 *  shape (the default bullet cycle, or a task checkbox). @internal */
type ListMarker =
  | { kind: 'text'; text: string }
  | { kind: 'shape'; shape: MarkerShape; actualText: string };

/** Options for {@link Flow.AddList}. All lengths are in points. */
export interface FlowListOptions {
  /** `false` → bullet list; `true` → `1.`/`2.`/`3.` numbered list. Default false. */
  ordered?: boolean;
  /** First ordinal for an ordered list. Integer. Default 1. */
  start?: number;
  /** Marker glyph for an unordered list. Default "•" (U+2022). */
  bullet?: string;
  /** Body + marker font. Default Helvetica. */
  font?: AuthoringFont;
  /** Font size (points). Default 11. */
  fontSize?: number;
  color?: [number, number, number];
  leading?: number;
  /** Rule below the baseline of the marker and of every body line. The marker
   *  and the body are decorated as two separate runs, so the gap between them
   *  stays blank. Default: none. */
  underline?: Decoration;
  /** Rule through the glyphs of the marker and of every body line. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind the marker and behind each body line. Default: none. */
  background?: Background;
  /** Body-text indent from the list's left edge (points). Default: auto —
   *  widest measured marker width + a half-em gap. */
  indent?: number;
  /** Vertical gap between consecutive items. >= 0. Default 0. */
  itemSpacing?: number;
  /** Gap above the whole list (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Gap below the whole list (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Body alignment. Default 'left'. */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Drop the list below the floats on the given side(s) before placing it.
   *  Applies to the first item only. Default: none. */
  clear?: FlowClear;
}

/** Resolved, validated list options (shared by every item of one list). @internal */
interface NormalizedListOptions {
  ordered: boolean;
  start: number;
  bulletOverride?: string;   // explicit bullet text, or undefined → vector cycle
  font: AuthoringFont;
  fontSize: number;
  color?: [number, number, number];
  leading?: number;
  underline?: Decoration;
  strikethrough?: Decoration;
  background?: Background;
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Gap between the marker's right edge and the body's left edge. */
  markerGap: number;
  itemSpacing: number;
  spaceBefore: number;
  spaceAfter: number;
  indentOverride?: number;   // uniform per-level step, or undefined → per-depth auto
}

/** Paint a vector list marker (disc/ring/square) whose right edge sits at
 *  `rightX`, centered near the first line's x-height. The marker's decoration is
 *  resolved here rather than inherited from `stampText`, because the shape is
 *  filled paths and not glyphs; its horizontal extent is the bullet's own box,
 *  its vertical extent the font's, so a bullet background lines up with the
 *  body's instead of floating as a small square at x-height. Wrapped in the
 *  /Lbl marked content when `tag` is given. @internal */
function drawShapeMarker(
  doc: Document, page: Page, shape: MarkerShape,
  rightX: number, baseline: number, o: NormalizedListOptions, tag?: StructElement,
): void {
  const fontSize = o.fontSize;
  // A checkbox is glyph-sized rather than bullet-sized: it stands in for a
  // character, not for a dot.
  const size = (isCheckShape(shape) ? 0.7 : 0.35) * fontSize;
  const color = o.color ?? [0, 0, 0];
  const [r, g, b] = color;
  const cy = baseline + 0.3 * fontSize; // ~ x-height midpoint
  const left = rightX - size;
  let s: string;
  if (isCheckShape(shape)) {
    const lw = Math.max(0.4, 0.07 * fontSize);
    const bottom = cy - size / 2;
    s = `q\n${num(r)} ${num(g)} ${num(b)} RG\n${num(lw)} w\n`
      + `${num(left + lw / 2)} ${num(bottom + lw / 2)} `
      + `${num(size - lw)} ${num(size - lw)} re\nS\n`;
    if (shape === 'checked') {
      // A two-segment tick inside the box.
      const x0 = left + 0.22 * size, y0 = bottom + 0.52 * size;
      const x1 = left + 0.42 * size, y1 = bottom + 0.28 * size;
      const x2 = left + 0.80 * size, y2 = bottom + 0.74 * size;
      s += `${num(x0)} ${num(y0)} m\n${num(x1)} ${num(y1)} l\n${num(x2)} ${num(y2)} l\nS\n`;
    }
    s += 'Q';
  } else if (shape === 'square') {
    s = `q\n${num(r)} ${num(g)} ${num(b)} rg\n`
      + `${num(left)} ${num(cy - size / 2)} ${num(size)} ${num(size)} re\nf\nQ`;
  } else {
    const rad = size / 2;
    const cx = left + rad;
    const k = rad * KAPPA;
    const path =
      `${num(cx + rad)} ${num(cy)} m\n`
      + `${num(cx + rad)} ${num(cy + k)} ${num(cx + k)} ${num(cy + rad)} ${num(cx)} ${num(cy + rad)} c\n`
      + `${num(cx - k)} ${num(cy + rad)} ${num(cx - rad)} ${num(cy + k)} ${num(cx - rad)} ${num(cy)} c\n`
      + `${num(cx - rad)} ${num(cy - k)} ${num(cx - k)} ${num(cy - rad)} ${num(cx)} ${num(cy - rad)} c\n`
      + `${num(cx + k)} ${num(cy - rad)} ${num(cx + rad)} ${num(cy - k)} ${num(cx + rad)} ${num(cy)} c\nh\n`;
    s = shape === 'disc'
      ? `q\n${num(r)} ${num(g)} ${num(b)} rg\n${path}f\nQ`
      : `q\n${num(r)} ${num(g)} ${num(b)} RG\n${num(Math.max(0.4, 0.08 * fontSize))} w\n${path}S\nQ`;
  }
  // Each decoration layer gets its own q/Q, so its fill colour cannot leak into
  // the shape or into whatever the page draws next. No `cm` is needed: this
  // function already works in absolute page space.
  const decor = resolveDecor(o, color, fontSize, vmetricsFor(o.font));
  const parts: string[] = [];
  if (decor) {
    const d = decorRects([{ x: left, baseline, width: size }], decor);
    if (d.beneath) parts.push(`q\n${d.beneath}Q`);
    parts.push(s);
    if (d.above) parts.push(`q\n${d.above}Q`);
  } else {
    parts.push(s);
  }
  const body = enc(parts.join('\n'));
  const tagged = tag
    ? wrapMarkedContent(tag.Type, allocContentMcid(doc, tag, page), body)
    : body;
  appendContent(doc, page, tagged);
}

/** The marker for item `index` (0-based) of an ordered/unordered sub-list at
 *  `depth`. Ordered → "N."; explicit bullet → that text; else the vector cycle.
 *  @internal */
function markerFor(
  cfg: { ordered: boolean; bulletOverride?: string; start: number }, index: number, depth: number,
): ListMarker {
  if (cfg.ordered) return { kind: 'text', text: `${cfg.start + index}.` };
  if (cfg.bulletOverride !== undefined) return { kind: 'text', text: cfg.bulletOverride };
  return { kind: 'shape', shape: BULLET_SHAPES[depth % 3], actualText: BULLET_GLYPHS[depth % 3] };
}

/** Rendered width of a marker for gutter sizing. @internal */
function markerWidth(m: ListMarker, fontSize: number, font: AuthoringFont): number {
  if (m.kind !== 'shape') return measureText(m.text, fontSize, font);
  return (isCheckShape(m.shape) ? 0.7 : 0.35) * fontSize;
}

/** Validate `options` and resolve the shared list geometry. Per-depth indents are
 *  computed in {@link buildListElements}. @internal */
function normalizeListOptions(o: FlowListOptions): NormalizedListOptions {
  const ordered = o.ordered ?? false;
  if (typeof ordered !== 'boolean') throw new TypeError('ordered must be a boolean');
  const start = o.start ?? 1;
  if (!Number.isInteger(start)) throw new TypeError('start must be an integer');
  if (o.bullet !== undefined && typeof o.bullet !== 'string')
    throw new TypeError('bullet must be a string');
  const font = o.font ?? 'Helvetica';
  const fontSize = o.fontSize ?? 11;
  if (!Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const itemSpacing = nonNegative(o.itemSpacing, 0, 'itemSpacing');
  const spaceBefore = nonNegative(o.spaceBefore, 0, 'spaceBefore');
  const spaceAfter = nonNegative(o.spaceAfter, 0, 'spaceAfter');
  const indentOverride = o.indent !== undefined ? nonNegative(o.indent, 0, 'indent') : undefined;
  validateDecoration('underline', o.underline);
  validateDecoration('strikethrough', o.strikethrough);
  validateBackground('background', o.background);
  return {
    ordered, start, bulletOverride: o.bullet, font, fontSize, color: o.color, leading: o.leading,
    underline: o.underline, strikethrough: o.strikethrough, background: o.background,
    align: o.align, markerGap: 0.5 * fontSize, itemSpacing, spaceBefore, spaceAfter, indentOverride,
  };
}

/** Shared across the items of one sub-list so they append to a single `/L` node,
 *  created lazily on the first item that actually draws. `parentBody` chains a
 *  nested sub-list's `/L` under its parent item's `/LBody`. @internal */
interface ListStructHolder { list?: StructElement; parentBody?: () => StructElement | undefined; }

/** Per-item state shared by every element one item lowers to.
 *
 *  **Invariant:** the marker is owned here, not by one element. An item may
 *  lower to a body plus several blocks, and whichever draws FIRST must paint
 *  the marker — with a private flag the text body owns it, so an item whose
 *  first block is a code block would never draw one at all. The `/LI`, `/Lbl`
 *  and `/LBody` nodes are shared for the same reason. @internal */
interface ItemState {
  markerDrawn: boolean;
  li?: StructElement;
  lbl?: StructElement;
  lbody?: StructElement;
}

/** Create this item's `/LI` + `/Lbl` + `/LBody` under its sub-list's `/L`, once.
 *  A no-op for an untagged flow. An element that draws nothing in this column
 *  leaves the nodes childless until it draws in the next one — the same
 *  behaviour an overflow probe has always had. @internal */
function ensureItemStruct(
  ctx: PlaceContext, marker: ListMarker, holder: ListStructHolder, state: ItemState,
): void {
  if (state.li !== undefined || !ctx.structParent) return;
  const parent = holder.parentBody?.() ?? ctx.structParent;
  if (holder.list === undefined) holder.list = parent.Append('L');
  state.li = holder.list.Append('LI');
  state.lbl = state.li.Append('Lbl',
    marker.kind === 'shape' ? { actualText: marker.actualText } : undefined);
  state.lbody = state.li.Append('LBody');
}

/** Paint the item's marker, right-aligned against the gutter so ordinals line up
 *  on the period, at the first line's baseline. Once per item. @internal */
function drawMarkerOnce(
  ctx: PlaceContext, marker: ListMarker, indent: number,
  o: NormalizedListOptions, state: ItemState,
): void {
  if (state.markerDrawn) return;
  const rightEdge = ctx.x + indent - o.markerGap;
  const baseline = ctx.top - o.fontSize; // = the body's first-line baseline
  if (marker.kind === 'shape') {
    drawShapeMarker(ctx.doc, ctx.page, marker.shape, rightEdge, baseline, o, state.lbl);
  } else {
    const mw = measureText(marker.text, o.fontSize, o.font);
    const markerOpts: StampOptions = {
      font: o.font, fontSize: o.fontSize, color: o.color,
      underline: o.underline, strikethrough: o.strikethrough, background: o.background,
      ...(state.lbl ? { tag: state.lbl } : {}),
    };
    stampText(ctx.doc, ctx.page, marker.text, rightEdge - mw, baseline, markerOpts);
  }
  state.markerDrawn = true;
}

/** The text-block options an item's body is flowed with. One definition, so
 *  `measure` and `place` cannot drift apart — a field added to one and not the
 *  other measures a layout it does not draw. @internal */
function bodyOptions(o: NormalizedListOptions): TextBlockOptions {
  return {
    font: o.font, fontSize: o.fontSize, color: o.color,
    align: o.align, leading: o.leading,
    underline: o.underline, strikethrough: o.strikethrough, background: o.background,
  };
}

/** One list item: a right-aligned marker (drawn once) plus a word-wrapped body
 *  flowed through {@link flowTextBlock} at an indented x. The marker is either a
 *  text glyph (ordinal / explicit bullet) or a vector shape (default cycle).
 *  Overflow yields a body-only continuation that carries no marker. @internal */
class ListItemElement implements FlowElement {
  /** Set on the list's first element only; a continuation never copies it. */
  clear?: FlowClear;

  constructor(
    private readonly text: FlowText,
    private readonly marker: ListMarker,
    private readonly indent: number,
    private readonly opts: NormalizedListOptions,
    public spaceBefore: number,
    public spaceAfter: number,
    private readonly holder: ListStructHolder,
    private readonly state: ItemState,
  ) {}

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const bodyOpts = bodyOptions(this.opts);
    const { usedHeight, remainder } =
      measureFlowText(this.text, ctx.width - this.indent, ctx.availHeight, bodyOpts);
    return { usedHeight, fits: remainder === null && usedHeight > 0 };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };

    // Lazily build /L → /LI → /Lbl + /LBody on first placement of non-empty text
    // under a tagged flow. Empty text never tags (no orphan); an overflow probe
    // that draws nothing leaves the nodes childless until the item draws. A nested
    // sub-list attaches its /L under the parent item's /LBody (parentBody), falling
    // back to the flow's struct parent at the top level.
    if (!isEmptyFlowText(this.text))
      ensureItemStruct(ctx, this.marker, this.holder, this.state);

    const bodyOpts: TextBlockOptions = {
      ...bodyOptions(this.opts),
      ...(this.state.lbody ? { tag: this.state.lbody } : {}),
    };
    const rect: [number, number, number, number] = [
      ctx.x + this.indent, ctx.top - ctx.availHeight,
      ctx.width - this.indent, ctx.availHeight,
    ];
    const { remainder, usedHeight } = drawFlowText(ctx.doc, ctx.page, this.text, rect, bodyOpts);

    if (usedHeight === 0) {
      // Nothing drawn: null remainder = empty (discard); else it did not fit the
      // leftover space (retry this element in the next column).
      return { usedHeight: 0, remainder: remainder === null ? null : this, drew: false };
    }

    drawMarkerOnce(ctx, this.marker, this.indent, this.opts, this.state);

    if (remainder === null) return { usedHeight, remainder: null, drew: true };
    // Continuation: body-only remainder sharing the same ItemState, so the marker
    // is not redrawn and the struct nodes are reused. spaceBefore = 0 (already
    // started), same spaceAfter.
    return {
      usedHeight,
      remainder: new ListItemElement(remainder, this.marker, this.indent, this.opts,
        0, this.spaceAfter, this.holder, this.state),
      drew: true,
    };
  }
}

/** One non-text block of a list item: the item's indent, the item's marker and
 *  `/LBody`, wrapped around an arbitrary element. Delegates place and measure —
 *  it does not paginate its child, exactly as a quoted element does not.
 *  @internal */
class ListBlockElement implements FlowElement {
  /** Set on the list's first element only; a continuation never copies it. */
  clear?: FlowClear;

  constructor(
    private readonly inner: FlowElement,
    private readonly marker: ListMarker,
    private readonly indent: number,
    private readonly opts: NormalizedListOptions,
    private readonly holder: ListStructHolder,
    private readonly state: ItemState,
    public spaceBefore: number,
    public spaceAfter: number,
  ) {}

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    return this.inner.measure?.({ width: ctx.width - this.indent, availHeight: ctx.availHeight })
      ?? { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    ensureItemStruct(ctx, this.marker, this.holder, this.state);
    const res = this.inner.place({
      ...ctx,
      x: ctx.x + this.indent,
      width: ctx.width - this.indent,
      // A block inside an item nests under /LBody, so a multi-paragraph item
      // reads as LI > LBody > P, P rather than as loose content.
      structParent: this.state.lbody ?? ctx.structParent,
    });
    if (res.drew) drawMarkerOnce(ctx, this.marker, this.indent, this.opts, this.state);
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null
        : new ListBlockElement(res.remainder, this.marker, this.indent, this.opts,
          this.holder, this.state, 0, this.spaceAfter),
    };
  }
}

/** One nested-list item. A bare string is a leaf item. */
export interface FlowListItem {
  /** The item's word-wrapped body text. A {@link TextRun} list mixes styles
   *  within the item; a bare string is one style throughout. Optional only when
   *  `blocks` is given — an item must have one or the other. */
  text?: FlowText;
  /** Draw a task-list checkbox for THIS item instead of the computed marker.
   *  Vector-drawn: WinAnsi has no ballot-box glyph. */
  marker?: 'checkbox' | 'checked';
  /** Further block content for THIS item, built with the flow builders
   *  (`paragraph`, `codeBlock`, `quote`, `list`). Each is placed at the item's
   *  own indent, under its `/LBody`, and the item's marker is drawn by whichever
   *  of the item's elements draws first. */
  blocks?: FlowElement[];
  /** Sub-list nested under this item. */
  items?: FlowListNode[];
  /** Override ordered-ness of THIS item's sub-list. Default: inherit the parent. */
  ordered?: boolean;
  /** Override the marker glyph of THIS item's (unordered) sub-list (drawn as text). */
  bullet?: string;
  /** First ordinal of THIS item's (ordered) sub-list. Integer. Default 1. */
  start?: number;
  /** Override the body + marker font for THIS item. Default: the list font. */
  font?: AuthoringFont;
  /** Override the body + marker font size (points) for THIS item. > 0. Default: the list size. */
  fontSize?: number;
  /** Override the body + marker colour (RGB 0..1) for THIS item. Default: the list colour. */
  color?: [number, number, number];
  /** Override the body alignment for THIS item. Default: the list alignment. */
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Override the body leading (points) for THIS item. >= 0. Default: the list leading. */
  leading?: number;
  /** Override the marker + body underline for THIS item. `false` switches the
   *  list-level value off. Default: the list value. */
  underline?: Decoration;
  /** Override the marker + body strikethrough for THIS item. Default: the list value. */
  strikethrough?: Decoration;
  /** Override the marker + body background for THIS item. Default: the list value. */
  background?: Background;
  /** Gap above THIS item, replacing the default (list spaceBefore at the first
   *  item, else 0). >= 0. */
  spaceBefore?: number;
  /** Gap below THIS item, replacing the default (list spaceAfter at the last
   *  item, else itemSpacing). >= 0. */
  spaceAfter?: number;
  /** Body indent (points from the list's left edge) for THIS item, replacing the
   *  per-depth auto/uniform indent. Affects only this item, not its descendants. */
  indent?: number;
}
/** A list node: a bare string leaf or a {@link FlowListItem} that may nest. */
export type FlowListNode = string | FlowListItem;

/** Per-sub-list marker configuration resolved during the tree walk. @internal */
interface SublistCfg { ordered: boolean; bulletOverride?: string; start: number }

/** Flatten the (possibly nested) `items` tree into a pre-order queue of
 *  {@link ListItemElement}s: per-depth cumulative indents (widest marker at each
 *  depth plus a marker gap, or the uniform `indent` override), chained struct
 *  holders so a sub-list's `/L` attaches under its parent item's `/LBody`, and a
 *  spacing post-pass over the flattened order. @internal */

/** Coerce/validate one raw node into a {@link FlowListItem}. @internal */
function validateNode(n: FlowListNode): FlowListItem {
  if (typeof n === 'string') return { text: n };
  if (typeof n !== 'object' || n === null)
    throw new TypeError('a list item must be a string or an object');
  if (n.text !== undefined && !(typeof n.text === 'string' || isTextRunList(n.text)))
    throw new TypeError('item.text must be a string or a run list');
  if (n.blocks !== undefined) {
    if (!Array.isArray(n.blocks)) throw new TypeError('item.blocks must be an array');
    for (const b of n.blocks) {
      if (typeof b !== 'object' || b === null || typeof (b as FlowElement).place !== 'function')
        throw new TypeError('each item.blocks entry must be a FlowElement (see the flow builders)');
    }
  }
  if (n.text === undefined && (n.blocks === undefined || n.blocks.length === 0))
    throw new TypeError('a list item must have text or blocks');
  if (n.marker !== undefined && n.marker !== 'checkbox' && n.marker !== 'checked')
    throw new TypeError("item.marker must be 'checkbox' or 'checked'");
  if (n.items !== undefined && !Array.isArray(n.items))
    throw new TypeError('item.items must be an array');
  if (n.ordered !== undefined && typeof n.ordered !== 'boolean')
    throw new TypeError('item.ordered must be a boolean');
  if (n.bullet !== undefined && typeof n.bullet !== 'string')
    throw new TypeError('item.bullet must be a string');
  if (n.start !== undefined && !Number.isInteger(n.start))
    throw new TypeError('item.start must be an integer');
  if (n.font !== undefined && typeof n.font !== 'string')
    throw new TypeError('item.font must be a string');
  if (n.fontSize !== undefined && (!Number.isFinite(n.fontSize) || n.fontSize <= 0))
    throw new TypeError('item.fontSize must be a positive finite number');
  if (n.color !== undefined
      && (!Array.isArray(n.color) || n.color.length !== 3 || !n.color.every((c) => typeof c === 'number')))
    throw new TypeError('item.color must be an [r, g, b] number triple');
  if (n.align !== undefined && !['left', 'center', 'right', 'justify'].includes(n.align))
    throw new TypeError('item.align must be left, center, right, or justify');
  if (n.leading !== undefined && (!Number.isFinite(n.leading) || n.leading < 0))
    throw new TypeError('item.leading must be a non-negative finite number');
  if (n.indent !== undefined && (!Number.isFinite(n.indent) || n.indent < 0))
    throw new TypeError('item.indent must be a non-negative finite number');
  if (n.spaceBefore !== undefined && (!Number.isFinite(n.spaceBefore) || n.spaceBefore < 0))
    throw new TypeError('item.spaceBefore must be a non-negative finite number');
  if (n.spaceAfter !== undefined && (!Number.isFinite(n.spaceAfter) || n.spaceAfter < 0))
    throw new TypeError('item.spaceAfter must be a non-negative finite number');
  validateDecoration('item.underline', n.underline);
  validateDecoration('item.strikethrough', n.strikethrough);
  validateBackground('item.background', n.background);
  return n;
}

/** Merge an item's style overrides onto the list options. Returns `list`
 *  unchanged when the item sets no style field (uniform-list fast path, keeping
 *  output byte-identical to a plain string list). @internal */
function resolveItemOptions(list: NormalizedListOptions, item: FlowListItem): NormalizedListOptions {
  if (item.font === undefined && item.fontSize === undefined && item.color === undefined
      && item.align === undefined && item.leading === undefined
      && item.underline === undefined && item.strikethrough === undefined
      && item.background === undefined) {
    return list;
  }
  return {
    ...list,
    font: item.font ?? list.font,
    fontSize: item.fontSize ?? list.fontSize,
    color: item.color ?? list.color,
    align: item.align ?? list.align,
    leading: item.leading ?? list.leading,
    // `??`, not `||`: an item's `underline: false` is an override that switches
    // the list-level rule off, not an absent value to fall back from.
    underline: item.underline ?? list.underline,
    strikethrough: item.strikethrough ?? list.strikethrough,
    background: item.background ?? list.background,
  };
}

function buildListElements(items: FlowListNode[], options: FlowListOptions): FlowElement[] {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const o = normalizeListOptions(options);

  interface Planned {
    item: FlowListItem; marker: ListMarker; depth: number;
    holder: ListStructHolder; opts: NormalizedListOptions;
    state: ItemState; elements: (ListItemElement | ListBlockElement)[];
  }
  const planned: Planned[] = [];
  const maxWidthByDepth: number[] = [];

  const walk = (nodes: FlowListNode[], depth: number, cfg: SublistCfg, holder: ListStructHolder) => {
    nodes.forEach((raw, index) => {
      const item = validateNode(raw);
      const itemOpts = resolveItemOptions(o, item);
      const marker: ListMarker = item.marker !== undefined
        ? {
          kind: 'shape',
          shape: item.marker,
          actualText: item.marker === 'checked' ? '☑' : '☐',
        }
        : markerFor(cfg, index, depth);
      maxWidthByDepth[depth] =
        Math.max(maxWidthByDepth[depth] ?? 0, markerWidth(marker, itemOpts.fontSize, itemOpts.font));
      const p: Planned = {
        item, marker, depth, holder, opts: itemOpts,
        state: { markerDrawn: false }, elements: [],
      };
      planned.push(p);
      if (item.items && item.items.length > 0) {
        const childCfg: SublistCfg = {
          ordered: item.ordered ?? cfg.ordered,
          bulletOverride: item.bullet,
          start: item.start ?? 1,
        };
        const childHolder: ListStructHolder = { parentBody: () => p.state.lbody };
        walk(item.items, depth + 1, childCfg, childHolder);
      }
    });
  };
  walk(items, 0, { ordered: o.ordered, bulletOverride: o.bulletOverride, start: o.start }, {});

  // Per-depth cumulative indent (uniform step when indentOverride is set).
  const cumulative: number[] = [];
  let acc = 0;
  for (let d = 0; d < maxWidthByDepth.length; d++) {
    acc += o.indentOverride ?? (maxWidthByDepth[d] ?? 0) + o.markerGap;
    cumulative[d] = acc;
  }

  // Construct elements, then assign spacing in flattened (pre-order) order. An
  // item lowers to its text body (when it has one) followed by its blocks, all
  // sharing the item's indent, marker and struct nodes.
  for (const p of planned) {
    const indent = p.item.indent ?? cumulative[p.depth];
    if (p.item.text !== undefined)
      p.elements.push(new ListItemElement(p.item.text, p.marker, indent, p.opts, 0, 0,
        p.holder, p.state));
    for (const b of p.item.blocks ?? [])
      p.elements.push(new ListBlockElement(b, p.marker, indent, p.opts, p.holder, p.state,
        b.spaceBefore ?? 0, b.spaceAfter ?? 0));
  }
  // The item-level gaps land on the item's first and last element; anything
  // between them keeps the spacing its own builder gave it.
  planned.forEach((p, i) => {
    const first = p.elements[0];
    const last = p.elements[p.elements.length - 1];
    first.spaceBefore = p.item.spaceBefore ?? (i === 0 ? o.spaceBefore : 0);
    last.spaceAfter = p.item.spaceAfter
      ?? (i === planned.length - 1 ? o.spaceAfter : o.itemSpacing);
  });
  const listClear = normalizeClear(options.clear);
  if (planned.length > 0) planned[0].elements[0].clear = listClear;
  return planned.flatMap((p) => p.elements);
}

/** Build the elements of a bullet or numbered list. The builder behind
 *  {@link Flow.AddList}. */
export function list(items: FlowListNode[], options: FlowListOptions = {}): FlowElement[] {
  return buildListElements(items, options);
}

/** Options for {@link Flow.AddImage}. All lengths are in points. */
export interface FlowImageOptions {
  /** Drawn width. Default: the column (region) width. Clamped down to the region
   *  width if larger (aspect preserved). > 0. */
  width?: number;
  /** Drawn height. Omitted/0 → auto from aspect ratio at the drawn width. >= 0. */
  height?: number;
  /** Force the decoder; default sniffs JPEG/PNG magic bytes. */
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
  /** Horizontal alignment within the column. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Alt text for the `/Figure` when the flow is tagged. */
  alt?: string;
  /** Points inserted above the image (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the image (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop the image below the floats on the given side(s) before placing it.
   *  Default: none. */
  clear?: FlowClear;
}

/** Options for {@link Flow.AddFloatingBox}: the block-level knobs every flow
 *  element shares. The box's own geometry comes from `Document.NewFloatingBox`. */
export interface FlowBoxOptions {
  /** Points inserted above the box (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the box (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop the box below the floats on the given side(s) before placing it.
   *  Default: none. */
  clear?: FlowClear;
}

/** An atomic raster image flow block (JPEG/PNG). Sized lazily from the region
 *  width so `place` and `measure` agree; never splits across a column. @internal */
class ImageElement implements FlowElement {
  private readonly iw: number;
  private readonly ih: number;

  constructor(
    private readonly built: BuiltImage,
    private readonly reqWidth: number | undefined,
    private readonly reqHeight: number | undefined,
    private readonly align: 'left' | 'center' | 'right',
    private readonly alt: string | undefined,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
  ) {
    this.iw = built.stream.dict.get('Width') as number;
    this.ih = built.stream.dict.get('Height') as number;
  }

  /** Drawn size for a given region width: default fills the region; an over-region
   *  width clamps down (requested aspect preserved). */
  private resolveSize(regionWidth: number): { drawW: number; drawH: number } {
    const baseW = this.reqWidth ?? regionWidth;
    const baseH = this.reqHeight !== undefined && this.reqHeight > 0
      ? this.reqHeight : baseW * (this.ih / this.iw);
    if (baseW > regionWidth) {
      const factor = regionWidth / baseW;
      return { drawW: regionWidth, drawH: baseH * factor };
    }
    return { drawW: baseW, drawH: baseH };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const { drawH } = this.resolveSize(ctx.width);
    return drawH <= ctx.availHeight + 1e-9
      ? { usedHeight: drawH, fits: true }
      : { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    const { drawW, drawH } = this.resolveSize(ctx.width);
    if (drawH > ctx.availHeight + 1e-9) return { usedHeight: 0, remainder: this, drew: false };
    const offsetX = this.align === 'center' ? (ctx.width - drawW) / 2
      : this.align === 'right' ? ctx.width - drawW : 0;
    const fig = ctx.structParent
      ? ctx.structParent.Append('Figure', this.alt !== undefined ? { alt: this.alt } : undefined)
      : undefined;
    drawBuiltImage(ctx.doc, ctx.page, this.built,
      [ctx.x + offsetX, ctx.top - drawH, drawW, drawH], fig ? { tag: fig } : {});
    return { usedHeight: drawH, remainder: null, drew: true };
  }
}

/** An in-flow {@link FloatingBox}: it consumes the full vertical band it needs
 *  and excludes nothing, so no text wraps beside it. Contrast the side float
 *  ({@link Flow.AddFloatBox}), which narrows the channel and needs the
 *  floatstack band bookkeeping. @internal */
class BoxElement implements FlowElement {
  constructor(
    private readonly box: FloatingBox,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
  ) {}

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const h = this.box.measure();
    return h <= ctx.availHeight + 1e-9
      ? { usedHeight: h, fits: true }
      : { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    const h = this.box.measure();
    // Atomic: a box too tall for what is left moves whole to the next column.
    // Splitting a callout across a column boundary reads as a rendering fault,
    // whereas a short column reads as layout — and the box's chrome (its border
    // and background) has no defined way to continue.
    if (h > ctx.availHeight + 1e-9) return { usedHeight: 0, remainder: this, drew: false };
    this.box.paintAt(ctx.page, ctx.x, ctx.top, ctx.structParent);
    return { usedHeight: h, remainder: null, drew: true };
  }
}

/** Validate `options`, embed the image, and build one {@link ImageElement}. @internal */
function buildImageElement(data: Uint8Array, o: FlowImageOptions): FlowElement {
  if (o.width !== undefined && (!Number.isFinite(o.width) || o.width <= 0))
    throw new TypeError('image width must be a positive finite number');
  if (o.height !== undefined && (!Number.isFinite(o.height) || o.height < 0))
    throw new TypeError('image height must be a non-negative finite number');
  const align = o.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  if (o.alt !== undefined && typeof o.alt !== 'string')
    throw new TypeError('alt must be a string');
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  const built = buildImageXObject(data, o.format);
  return new ImageElement(built, o.width, o.height, align, o.alt, spaceBefore, spaceAfter,
    normalizeClear(o.clear));
}

/** Build a raster image element (JPEG/PNG). The builder behind
 *  {@link Flow.AddImage}. */
export function image(data: Uint8Array, options: FlowImageOptions = {}): FlowElement[] {
  return [buildImageElement(data, options)];
}

/** Sentinel enqueued by {@link Flow.AddColumnBreak}. @internal */
interface ColumnBreak { readonly kind: 'column-break'; }
/** A floating box enqueued by {@link Flow.AddFloatBox}. @internal */
interface FloatItem { readonly kind: 'float'; readonly box: FloatingBox; readonly side: 'left' | 'right'; }
type FlowItem = FlowElement | ColumnBreak | FloatItem;
function isBreak(item: FlowItem): item is ColumnBreak {
  return (item as ColumnBreak).kind === 'column-break';
}
function isFloat(item: FlowItem): item is FloatItem {
  return (item as FloatItem).kind === 'float';
}

/** A flow layout container. Create via {@link Document.NewFlow}. Queue content
 *  with {@link AddParagraph}/{@link AddColumnBreak}, then call {@link Render} to
 *  append the laid-out pages to the document. */
export class Flow {
  private readonly geometry: Geometry;
  private readonly items: FlowItem[] = [];
  private readonly tagged: boolean;
  private readonly lang?: string;
  private readonly keepHeadingsWithNext: boolean;
  private rendered = false;

  constructor(private readonly doc: Document, options?: FlowOptions) {
    this.geometry = normalizeFlowOptions(options);
    if (options?.tagged !== undefined && typeof options.tagged !== 'boolean')
      throw new TypeError('tagged must be a boolean');
    this.tagged = options?.tagged ?? false;
    // Validated here rather than in normalizeFlowOptions, which returns Geometry
    // — page and column measurements only, and it never sees `tagged`. The
    // cross-check belongs where both values are in hand.
    if (options?.lang !== undefined) {
      if (typeof options.lang !== 'string' || options.lang === '')
        throw new TypeError('lang must be a non-empty string');
      if (!this.tagged)
        throw new TypeError('lang requires tagged: true — an untagged flow has no /Sect to carry it');
    }
    this.lang = options?.lang;
    if (options?.keepHeadingsWithNext !== undefined && typeof options.keepHeadingsWithNext !== 'boolean')
      throw new TypeError('keepHeadingsWithNext must be a boolean');
    this.keepHeadingsWithNext = options?.keepHeadingsWithNext ?? true;
  }

  /** Append a word-wrapped paragraph. Chainable. */
  AddParagraph(text: FlowText, options: FlowParagraphOptions = {}): this {
    this.items.push(...paragraph(text, options));
    return this;
  }

  /** Append a word-wrapped heading. `level` is an integer 1..6, driving a default
   *  font size (24/18/14/12/10/8) and a Helvetica-Bold default, both overridable
   *  via `options`, and (when the flow is tagged) the `/H1`..`/H6` structure type.
   *  Chainable. */
  AddHeading(level: number, text: FlowText, options: FlowHeadingOptions = {}): this {
    this.items.push(...heading(level, text, options));
    return this;
  }

  /** Append a bullet (default) or numbered (`{ ordered: true }`) list. Each
   *  string in `items` is one word-wrapped item; the marker is drawn once even
   *  when an item spans a column/page boundary. Empty array is a no-op. Items may
   *  nest: pass `{ text, items: [...] }` for a sub-list — sub-lists indent per
   *  depth, ordered numbering restarts per level, and unordered markers cycle
   *  • ◦ ▪ (drawn as vector shapes). An item's `ordered`/`bullet`/`start` override
   *  its own sub-list. Chainable. */
  AddList(items: FlowListNode[], options: FlowListOptions = {}): this {
    this.items.push(...list(items, options));
    return this;
  }

  /** Append a raster image (JPEG/PNG) as its own flow block. Sized to the column
   *  by default (aspect height); an over-column width is clamped. Atomic — it
   *  never splits across a column. Chainable. */
  AddImage(data: Uint8Array, options: FlowImageOptions = {}): this {
    this.items.push(...image(data, options));
    return this;
  }

  /** Append a horizontal rule — a section divider, and Markdown's thematic
   *  break. Atomic: it never splits across a column. Chainable. */
  AddRule(options: FlowRuleOptions = {}): this {
    this.items.push(...rule(options));
    return this;
  }

  /** Append a preformatted code block. Indentation and line breaks are
   *  preserved; a line too wide for the column wraps rather than running off the
   *  page. Splits between source lines across a column. Chainable. */
  AddCodeBlock(text: string, options: FlowCodeOptions = {}): this {
    this.items.push(...codeBlock(text, options));
    return this;
  }

  /** Append a block quote: the given elements, indented behind a gutter bar.
   *  Build the elements with the flow builders (`paragraph`, `list`,
   *  `codeBlock`, `quote` itself for a nested quote). Each child paginates on its
   *  own, so a long quote flows across columns and its bar follows. Chainable. */
  AddQuote(blocks: FlowElement[], options: FlowQuoteOptions = {}): this {
    this.items.push(...quote(blocks, options));
    return this;
  }

  /** Append a table built with `createTable`, paginating by row across columns
   *  and pages. Repeating header rows (`setRepeatingRowsCount`) reprint at the
   *  top of each continuation. Unlike `page.AddTable` this is positioned by the
   *  flow rather than by the caller, and a split table stays one `/Table` under
   *  a tagged flow. Chainable. */
  AddTable(t: TableBuilder, options: FlowTableOptions = {}): this {
    this.items.push(...table(t, options));
    return this;
  }

  /** Append a Markdown document: CommonMark 0.31.2, or GFM with
   *  `{ gfm: true }`. Headings, paragraphs, lists (tight/loose, task items),
   *  code blocks, block quotes, thematic breaks and figures all map onto flow
   *  elements, so the result paginates, tags and mixes with hand-built content
   *  like any other flow.
   *
   *  Unlike the other `Add*` methods this returns a report rather than `this`:
   *  `skipped` names every construct that did not render (a table, raw HTML, an
   *  image whose destination could not be resolved), and without it a caller
   *  cannot tell a dropped table from an empty document. */
  AddMarkdown(src: string | MdDocument, options: MarkdownFlowOptions = {}): MarkdownResult {
    const { elements, skipped } = markdownElements(src, options);
    this.items.push(...elements);
    return { skipped };
  }

  /** Force the following content to start in the next column (next page if in
   *  the last column). Chainable. */
  AddColumnBreak(): this {
    this.items.push({ kind: 'column-break' });
    return this;
  }

  /** Float `box` to the `left` or `right` of the column; following flow text
   *  wraps in the narrowed channel beside it and resumes full width below.
   *  Chainable. */
  AddFloatBox(box: FloatingBox, side: 'left' | 'right'): this {
    if (side !== 'left' && side !== 'right') throw new TypeError("side must be 'left' or 'right'");
    this.items.push({ kind: 'float', box, side });
    return this;
  }

  /** Place `box` in the flow itself — a pull-quote, callout or formula card. It
   *  consumes the vertical space it needs and excludes no band, so nothing wraps
   *  beside it (that is {@link AddFloatBox}). The box keeps its own `width`; it
   *  is not stretched or clamped to the column. Atomic: one that does not fit in
   *  what is left of the column moves whole to the next. Its `spacing` applies
   *  above and below, on top of the flow's `paragraphSpacing`, matching the side
   *  float. Chainable. */
  AddFloatingBox(box: FloatingBox, options: FlowBoxOptions = {}): this {
    if (!(box instanceof FloatingBox))
      throw new TypeError('box must be a FloatingBox (see Document.NewFloatingBox)');
    const { spaceBefore, spaceAfter } = normalizeSpacing(options);
    this.items.push(new BoxElement(
      box, spaceBefore + box.spacing, spaceAfter + box.spacing, normalizeClear(options.clear)));
    return this;
  }

  /** Lay out the queued content, appending fresh pages at the end of the
   *  document, and return those pages in order. Single-shot: a second call
   *  throws. */
  Render(): Page[] {
    if (this.rendered) throw new Error('Flow already rendered');
    this.rendered = true;
    const g = this.geometry;
    const pages: Page[] = [];
    const ensurePage = (idx: number): Page => {
      while (pages.length <= idx) {
        pages.push(this.doc.AddPage(g.format).page);
      }
      return pages[idx];
    };

    const structParent = this.tagged
      ? this.doc.CreateStructTree().Append('Sect')
      : undefined;
    if (structParent !== undefined && this.lang !== undefined) structParent.Lang = this.lang;

    const queue: FlowItem[] = [...this.items];
    let pageIdx = 0;
    let col = 0;
    let colTop = g.contentTop;
    let atColumnStart = true;
    let pendingSpaceAfter = 0; // spaceAfter of the last fully-placed element in this column
    // Floats active in the current column: left and right concurrently, stacked
    // vertically per side. `band` is the horizontal space to avoid; `bottom` the
    // y the box reaches down to.
    let floats: ActiveFloat[] = [];
    // Floats deferred from a column that ran out of room, re-queued at the top
    // of the next one.
    let pending: FloatItem[] = [];
    const advanceColumn = () => {
      col++;
      if (col >= g.columns) { col = 0; pageIdx++; }
      colTop = g.contentTop;
      atColumnStart = true;
      pendingSpaceAfter = 0;
      floats = [];
      // Carried floats lead the new column — ahead of any remainder a caller
      // re-queued just before calling us, so its text wraps beside them.
      if (pending.length > 0) { queue.unshift(...pending); pending = []; }
    };

    while (queue.length > 0 || pending.length > 0) {
      // Only carried floats left: open the column they were deferred to. The
      // loop condition guarantees `pending` is non-empty here, so advanceColumn
      // always re-queues work and this cannot spin.
      if (queue.length === 0) { advanceColumn(); continue; }
      const item = queue[0];
      if (isBreak(item)) { queue.shift(); advanceColumn(); continue; }

      // Clear the floats the pen has passed.
      floats = pruneFloats(floats, colTop);

      if (isFloat(item)) {
        const box = item.box;
        const h = box.measure();
        const gap = atColumnStart ? 0 : pendingSpaceAfter + g.paragraphSpacing + box.spacing;
        const naturalTop = colTop - gap;
        // Never share a side; sit beside an opposing float only when the box
        // still fits the channel it leaves.
        const boxTop = resolveFloatTop(
          floats, item.side, box.width, box.spacing, naturalTop, g.columnWidth);
        if (boxTop - h < g.contentBottom - 1e-9) {
          if (atColumnStart)
            throw new Error('Flow: floating box does not fit in an empty column (column too short for the box)');
          // Defer rather than advancing: taking the column with us would abandon
          // the rest of it. Following content keeps filling this column and the
          // box leads the next one. A column start has no active floats, so a
          // carried float there either fits or throws — this terminates.
          pending.push(item);
          queue.shift();
          continue;
        }
        const page = ensurePage(pageIdx);
        const boxX = item.side === 'left'
          ? columnX(g, col)
          : columnX(g, col) + g.columnWidth - box.width;
        box.paintAt(page, boxX, boxTop, structParent);
        floats.push({ side: item.side, band: box.width + box.spacing, bottom: boxTop - h });
        // A float never advances the pen past itself: one placed at the pen
        // consumes its leading gap, a pushed one leaves the pen alone. The
        // comparison is exact — resolveFloatTop returns the very naturalTop it
        // was given when nothing pushes the box.
        if (boxTop === naturalTop) colTop = boxTop;
        atColumnStart = false;
        pendingSpaceAfter = 0;
        queue.shift();
        continue;
      }

      // Clear: drop the pen below the floats on the requested side(s). Idempotent
      // — the cleared floats are pruned, so re-entering with the same element
      // (a boundary skip, a retry) changes nothing further. Side-selective: a
      // deeper float on the other side stays in force and still narrows the
      // region. Moves the pen only — the gap below is computed as usual, and
      // atColumnStart is untouched.
      if (item.clear) {
        const target = clearTo(floats, item.clear);
        if (target !== undefined) {
          colTop = target;
          floats = pruneFloats(floats, colTop);
        }
      }

      // Gap above this element, dropped entirely at a column top.
      const gap = atColumnStart ? 0
        : pendingSpaceAfter + g.paragraphSpacing + (item.spaceBefore ?? 0);
      const top = colTop - gap;

      // Region: narrowed by the floats in force at `top`, and capped at the y
      // where the channel next widens so the element re-flows there.
      const { left: insetL, right: insetR } = insetsAt(floats, top);
      const besideFloat = insetL > 0 || insetR > 0;
      // Defined whenever besideFloat: a non-zero inset means a float is in force.
      const boundary = besideFloat ? nextBoundary(floats, top)! : 0;
      const elemX = columnX(g, col) + insetL;
      const elemWidth = g.columnWidth - insetL - insetR;
      const availHeight = besideFloat ? top - boundary : top - g.contentBottom;

      // A left and a right band can swallow the column between them: skip the pen
      // to where it reopens rather than placing into a negative-width region.
      if (elemWidth <= 0) {
        colTop = boundary;
        floats = pruneFloats(floats, colTop);
        continue;
      }

      // Keep-with-next: an eligible heading that fully fits here but leaves no room
      // for the next element's first line pushes to the next column. Never at a
      // column start (that would loop) and never beside a float (out of scope).
      const keep = item.keepWithNextEligible
        && (item.keepWithNext ?? this.keepHeadingsWithNext);
      if (keep && !atColumnStart && !besideFloat && item.measure) {
        const self = item.measure({ width: elemWidth, availHeight });
        if (self.fits) {
          const next = queue.length > 1 && !isBreak(queue[1]) && !isFloat(queue[1])
            ? (queue[1] as FlowElement) : undefined;
          if (next?.measure) {
            const gapNext = (item.spaceAfter ?? 0) + g.paragraphSpacing + (next.spaceBefore ?? 0);
            const remaining = (top - self.usedHeight) - gapNext - g.contentBottom;
            if (next.measure({ width: g.columnWidth, availHeight: remaining }).usedHeight <= 0) {
              advanceColumn();
              continue;
            }
          }
        }
      }

      const page = ensurePage(pageIdx); // create a page only when content needs it
      const res = item.place({
        doc: this.doc, page, x: elemX, top, width: elemWidth, availHeight,
        paragraphSpacing: g.paragraphSpacing, structParent,
      });

      if (res.drew) {
        queue.shift();
        colTop = top - res.usedHeight; // consume the gap and the used height
        atColumnStart = false;
        if (res.remainder) {
          queue.unshift(res.remainder);
          if (besideFloat) {
            // Reflowed where the channel widens: continue there — possibly still
            // beside a taller float on the other side.
            colTop = boundary;
            floats = pruneFloats(floats, colTop);
          } else {
            advanceColumn();
          }
        } else {
          pendingSpaceAfter = item.spaceAfter ?? 0;
        }
        continue;
      }
      // Nothing painted.
      if (res.remainder === null) { queue.shift(); continue; } // empty element
      if (besideFloat) {
        // Could not fit even one line in this channel: skip to where it widens.
        colTop = boundary;
        floats = pruneFloats(floats, colTop);
        continue;
      }
      if (atColumnStart)
        throw new Error('Flow: element does not fit in an empty column (column too short for its content)');
      advanceColumn();
    }

    if (pages.length === 0) ensurePage(0); // always produce at least one page
    return pages;
  }
}
