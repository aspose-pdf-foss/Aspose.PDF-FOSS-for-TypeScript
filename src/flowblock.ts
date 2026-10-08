/** The three block-level Flow elements Markdown needs and Flow lacked: a
 *  thematic break, a preformatted code block, and a block quote.
 *
 *  Its own module because flow.ts is already large and because these three
 *  implement the protocol rather than owning the engine. It imports the
 *  protocol from flowelement.ts, never from flow.ts, so flow.ts importing the
 *  builders back closes no cycle. */

import {
  insetScale, nonNegative, normalizeClear, normalizeSpacing, type Compromise,
  type FlowClear, type FlowElement, type HeadingSlot, type MeasureContext, type MeasureResult, type PlaceContext, type PlaceResult,
} from './flowelement.js';
import type { StructElement } from './struct.js';
import type { NoteRef } from './flownotes.js';
import { preformat } from './preformat.js';
import { EmbeddedFont } from './embeddedfont.js';
import { coverageOf, type Undrawable } from './textcoverage.js';
export { preformat } from './preformat.js';
import { num, appendContent, wrapArtifact } from './pagecontent.js';
import { enc } from './serialize.js';
import {
  flowTextBlock, measureTextBlock, type TextBlockOptions, type AuthoringFont,
} from './stamp.js';

/** Validate an RGB triple in 0..1. */
function checkColor(label: string, c: unknown): [number, number, number] {
  if (!Array.isArray(c) || c.length !== 3
      || !c.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))
    throw new TypeError(`${label} must be [r, g, b] with each component in 0..1`);
  return c as [number, number, number];
}

/** Validate an optional strictly-positive finite number. */
function positive(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n <= 0)
    throw new TypeError(`${name} must be a positive finite number`);
  return n;
}

/** Operators for a filled rectangle in its own q/Q, so the fill colour cannot
 *  leak into whatever the page draws next.
 *
 *  Exported for cssframe.ts, which paints a CSS box's background and its four
 *  border edges as filled rects. @internal */
export function fillRect(
  x: number, y: number, w: number, h: number, color: [number, number, number],
): Uint8Array {
  return enc(`q\n${num(color[0])} ${num(color[1])} ${num(color[2])} rg\n`
    + `${num(x)} ${num(y)} ${num(w)} ${num(h)} re\nf\nQ`);
}

/** Paint `body` on the page, marked as an /Artifact when the flow is tagged.
 *  A rule, a code-block fill and a quote bar are all decoration: they carry no
 *  meaning a screen reader should announce, and in a tagged document every
 *  piece of content must be either tagged or artifacted.
 *
 *  Exported for cssframe.ts, which must artifact a CSS box's background and
 *  borders by the same rule. One owner, so the two cannot come to disagree
 *  about whether decoration is announced. @internal */
export function paintDecoration(ctx: PlaceContext, body: Uint8Array): void {
  appendContent(ctx.doc, ctx.page, ctx.structParent ? wrapArtifact(body) : body);
}

/** Options for {@link rule} / `Flow.AddRule`. Lengths in points. */
export interface FlowRuleOptions {
  /** Rule thickness. > 0. Default 0.5. */
  thickness?: number;
  /** Rule colour (RGB 0..1). Default a mid grey. */
  color?: [number, number, number];
  /** Rule width. > 0. Default: the full region width. */
  width?: number;
  /** Horizontal placement of an explicit `width` within the region. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Points inserted above the rule (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the rule (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop the rule below the floats on the given side(s) before placing it. */
  clear?: FlowClear;
}

const RULE_COLOR: [number, number, number] = [0.6, 0.6, 0.6];

/** A horizontal rule. Atomic: it either fits in what is left of the column or
 *  moves whole to the next. @internal */
class RuleElement implements FlowElement {
  constructor(
    private readonly thickness: number,
    private readonly color: [number, number, number],
    private readonly reqWidth: number | undefined,
    private readonly align: 'left' | 'center' | 'right',
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
  ) {}

  /** Drawn width and its x offset for a given region width. */
  private geometry(regionWidth: number): { w: number; dx: number } {
    const w = Math.min(this.reqWidth ?? regionWidth, regionWidth);
    const dx = this.align === 'center' ? (regionWidth - w) / 2
      : this.align === 'right' ? regionWidth - w : 0;
    return { w, dx };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    return this.thickness <= ctx.availHeight + 1e-9
      ? { usedHeight: this.thickness, fits: true }
      : { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (this.thickness > ctx.availHeight + 1e-9)
      return { usedHeight: 0, remainder: this, drew: false };
    const { w, dx } = this.geometry(ctx.width);
    paintDecoration(ctx,
      fillRect(ctx.x + dx, ctx.top - this.thickness, w, this.thickness, this.color));
    return { usedHeight: this.thickness, remainder: null, drew: true };
  }
}

/** Build a horizontal rule element — Markdown's thematic break, and a section
 *  divider for any hand-built flow. The builder behind `Flow.AddRule`. */
export function rule(options: FlowRuleOptions = {}): FlowElement[] {
  const thickness = positive(options.thickness, 0.5, 'thickness');
  const color = options.color === undefined ? RULE_COLOR : checkColor('color', options.color);
  const width = options.width === undefined ? undefined : positive(options.width, 1, 'width');
  const align = options.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  const { spaceBefore, spaceAfter } = normalizeSpacing(options);
  return [new RuleElement(thickness, color, width, align, spaceBefore, spaceAfter,
    normalizeClear(options.clear))];
}

/** Options for {@link codeBlock} / `Flow.AddCodeBlock`. */
export interface FlowCodeOptions {
  /** Body font. Default 'Courier'. */
  font?: AuthoringFont;
  /** Font size (points). > 0. Default 9. */
  fontSize?: number;
  /** Text colour (RGB 0..1). Default black. */
  color?: [number, number, number];
  /** Baseline-to-baseline distance. Default 1.2 * fontSize. */
  leading?: number;
  /** Fill painted behind the block, or `false` for none. Default a light grey. */
  background?: [number, number, number] | false;
  /** Inset between the fill's edge and the text, all four sides. >= 0. Default 4. */
  padding?: number;
  /** Columns a tab advances to. Integer > 0. Default 4. */
  tabWidth?: number;
  /** Points inserted above the block (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the block (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop the block below the floats on the given side(s) before placing it. */
  clear?: FlowClear;
  /** Called when the resolved face cannot draw some or all of this text.
   *  Opt-in: a caller who passes nothing gets the previous silence. Fires once,
   *  at BUILD time. */
  onUndrawable?: (u: Undrawable) => void;
}

const CODE_BACKGROUND: [number, number, number] = [0.96, 0.96, 0.96];

/** A preformatted block: monospaced, indentation-preserving, optionally on a
 *  fill. An ordinary text element underneath, so it inherits pagination,
 *  measurement and tagging rather than growing a second layout path. @internal */
class CodeBlockElement implements FlowElement {
  /** See {@link FlowElement.onCompromise}. */
  onCompromise?: (how: Compromise) => void;

  constructor(
    /** Already through {@link preformat}. */
    private readonly text: string,
    private readonly opts: TextBlockOptions,
    private readonly padding: number,
    private readonly background: [number, number, number] | undefined,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
    /** The /Code this block's text tags into, created on first draw and carried
     *  into the continuation so a split code block is ONE element. */
    private code?: StructElement,
  ) {}

  /** The text box inside the padding, for a given region, plus the HORIZONTAL
   *  padding it actually got.
   *
   *  That padding is scaled down for a region too narrow to carry it (`e1bp`) —
   *  a code block inside quotes that have exhausted the column is the one
   *  element two rules can squeeze at once, and unscaled it took the last of
   *  the width and drew nothing. The VERTICAL padding is untouched: a short
   *  column is not a narrow one, and the engine already answers it by moving
   *  the block to the next column. */
  private inner(width: number, availHeight: number): { w: number; h: number; padX: number } {
    const padX = this.padding * insetScale(width, 2 * this.padding);
    return { w: width - 2 * padX, h: availHeight - 2 * this.padding, padX };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const { w, h } = this.inner(ctx.width, ctx.availHeight);
    if (w <= 0 || h <= 0) return { usedHeight: 0, fits: false };
    const { usedHeight, remainder } = measureTextBlock(this.text, w, h, this.opts);
    // Nothing drawn: a null remainder means there was nothing to draw (discard),
    // not that it did not fit here. Padding is not reserved for absent content.
    if (usedHeight === 0) return { usedHeight: 0, fits: remainder === null };
    return { usedHeight: usedHeight + 2 * this.padding, fits: remainder === null };
  }

  place(ctx: PlaceContext): PlaceResult {
    const { w, h, padX } = this.inner(ctx.width, ctx.availHeight);
    if (w <= 0 || h <= 0) return { usedHeight: 0, remainder: this, drew: false };
    // Measure first so the fill can be painted at the right height BEFORE the
    // text, which is what puts the glyphs on top of it. measureTextBlock runs
    // the identical layout, so the two agree by construction.
    const probe = measureTextBlock(this.text, w, h, this.opts);
    if (probe.usedHeight === 0)
      return { usedHeight: 0, remainder: probe.remainder === null ? null : this, drew: false };
    const used = probe.usedHeight + 2 * this.padding;
    // (kk3q) Its OWN horizontal padding scaled down; reported only now that
    // the block is known to draw.
    if (padX < this.padding) this.onCompromise?.('squeezed');
    if (this.background)
      paintDecoration(ctx, fillRect(ctx.x, ctx.top - used, ctx.width, used, this.background));
    const rect: [number, number, number, number] =
      [ctx.x + padX, ctx.top - used + this.padding, w, probe.usedHeight];
    // Created on the first draw, never at construction: a code block that draws
    // nothing must leave no orphan element behind — the rule TextElement and
    // TableTagger both follow. /P is block level and /Code is inline level
    // (32000-1 14.8.4.3), so a bare /Code here would put an ILSE where a BLSE
    // belongs — which this repo's own validator has no rule to catch.
    if (this.code === undefined && ctx.structParent !== undefined)
      this.code = ctx.structParent.Append('P').Append('Code');
    const opts = this.code ? { ...this.opts, tag: this.code } : this.opts;
    const { remainder } = flowTextBlock(ctx.doc, ctx.page, this.text, rect, opts);
    return {
      usedHeight: used,
      remainder: remainder === null ? null
        : new CodeBlockElement(remainder, this.opts, this.padding, this.background,
          0, this.spaceAfter, undefined, this.code),
      drew: true,
    };
  }
}

/** Build a preformatted code block: monospaced, indentation-preserving, wrapped
 *  only where a line is too wide for the column. Splits between source lines
 *  across a column boundary. The builder behind `Flow.AddCodeBlock`. */
export function codeBlock(text: string, options: FlowCodeOptions = {}): FlowElement[] {
  if (typeof text !== 'string') throw new TypeError('code block text must be a string');
  const fontSize = positive(options.fontSize, 9, 'fontSize');
  const tabWidth = options.tabWidth ?? 4;
  if (!Number.isInteger(tabWidth) || tabWidth <= 0)
    throw new TypeError('tabWidth must be an integer > 0');
  const padding = nonNegative(options.padding, 4, 'padding');
  const background = options.background === false ? undefined
    : options.background === undefined ? CODE_BACKGROUND
      : checkColor('background', options.background);
  if (options.color !== undefined) checkColor('color', options.color);
  const opts: TextBlockOptions = {
    font: options.font ?? 'Courier',
    fontSize,
    color: options.color,
    leading: options.leading,
    align: 'left',
  };
  // The PREFORMATTED text, not the raw text: the U+00A0 substitution is what
  // actually reaches the driver, so judging the raw text would report
  // characters the painter never sees. Its own four-line copy of flow.ts's
  // reportCoverage rather than an import — flow.ts imports THIS module, so
  // reaching back would close a cycle.
  if (options.onUndrawable !== undefined) {
    const f = opts.font ?? 'Courier';
    const u = coverageOf(preformat(text, tabWidth), f, f instanceof EmbeddedFont && f.shape);
    if (u !== undefined) options.onUndrawable(u);
  }
  const { spaceBefore, spaceAfter } = normalizeSpacing(options);
  return [new CodeBlockElement(preformat(text, tabWidth), opts, padding, background,
    spaceBefore, spaceAfter, normalizeClear(options.clear))];
}

/** The bar drawn down a quote's gutter. */
export interface FlowQuoteBar {
  /** Bar thickness. >= 0. Default 3. */
  width?: number;
  /** Bar colour (RGB 0..1). Default a light grey. */
  color?: [number, number, number];
  /** Points from the region's left edge to the bar's left edge. >= 0. Default 0. */
  offset?: number;
}

/** Options for {@link quote} / `Flow.AddQuote`. */
export interface FlowQuoteOptions {
  /** Points the contents are indented from the region's left edge. >= 0. Default 18. */
  indent?: number;
  /** The gutter bar, or `false` for none. Default: a 3pt light-grey bar at the edge. */
  bar?: FlowQuoteBar | false;
  /** Points inserted above the quote (dropped at a column top). >= 0. Default 0. */
  spaceBefore?: number;
  /** Points inserted below the quote (dropped at a column top). >= 0. Default 0. */
  spaceAfter?: number;
  /** Drop the quote below the floats on the given side(s) before placing it.
   *  Applies to its first element only. */
  clear?: FlowClear;
}

interface ResolvedBar { width: number; color: [number, number, number]; offset: number }

const QUOTE_BAR_COLOR: [number, number, number] = [0.8, 0.8, 0.8];

/** The /BlockQuote a quote's children share.
 *
 *  **Invariant:** this is per-QUOTE state, not per-element. `quote()` lowers to
 *  one QuotedElement per child block, and whichever draws FIRST creates the
 *  element while every other sibling must find it — give each its own and a
 *  three-paragraph quote becomes three /BlockQuotes. The same holder rides into
 *  a continuation, so a quote split across a column stays one element. This is
 *  the pattern gl6o.3.2 used for a list item's marker and gl6o.3.3 for a split
 *  table's TableTagger. @internal */
interface QuoteStruct { elem?: StructElement }

/** One quoted child: an indent plus its own ink.
 *
 *  **Invariant:** a container never holds and paginates its children. This
 *  decorates exactly ONE inner element and delegates place/measure to it, so a
 *  quote split across a column needs no special case — each element paints its
 *  bar wherever it lands, and a nested quote is just this wrapping itself.
 *  @internal */
class QuotedElement implements FlowElement {
  constructor(
    private readonly inner: FlowElement,
    private readonly indent: number,
    private readonly bar: ResolvedBar | undefined,
    /** Whether another block of THIS quote follows. False on the last one, whose
     *  bar must stop at its own bottom rather than run on into whatever the
     *  document places next. */
    private readonly continues: boolean,
    /** Points of following gap the bar covers, over and above the engine's own
     *  paragraphSpacing. Meaningless unless `continues`. */
    private readonly barExtend: number,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
    /** Shared with every sibling of this quote; see {@link QuoteStruct}. */
    private readonly st: QuoteStruct = {},
  ) {}

  get keepWithNextEligible(): boolean | undefined { return this.inner.keepWithNextEligible; }
  get keepWithNext(): boolean | undefined { return this.inner.keepWithNext; }

  /** Forwarded to the element inside, as `cssframe.ts`'s `BoxElement` does
   *  (`kk3q`): a nest of decorators is then ONE callback, owned by the element
   *  that actually draws, so the `'squeezed'` every scaled level fires is one
   *  record rather than one per level. */
  get onCompromise(): ((how: Compromise) => void) | undefined {
    return this.inner.onCompromise;
  }

  set onCompromise(fn: ((how: Compromise) => void) | undefined) {
    this.inner.onCompromise = fn;
  }

  /** The indent this width can afford (`e1bp`). Read through `insetScale` and
   *  never as `this.indent`, or a quote nested past the column width drives the
   *  content to zero and `stamp.ts` refuses the rect. ONE definition, because
   *  `measure` and `place` disagreeing about an indent is how a quote comes to
   *  be measured one way and painted another. */
  private indentFor(width: number): number {
    return this.indent * insetScale(width, this.indent);
  }

  noteRefs(): NoteRef[] { return this.inner.noteRefs?.() ?? []; }
  headingSlot(): HeadingSlot | undefined { return this.inner.headingSlot?.(); }

  measure(ctx: MeasureContext): MeasureResult {
    // Every element in this repo implements measure; the fallback is unreachable
    // and exists only because the protocol declares it optional.
    const indent = this.indentFor(ctx.width);
    return this.inner.measure?.({ width: ctx.width - indent, availHeight: ctx.availHeight })
      ?? { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    // Created on the first sibling that draws, so a quote that draws nothing
    // leaves no orphan element.
    if (this.st.elem === undefined && ctx.structParent !== undefined)
      this.st.elem = ctx.structParent.Append('BlockQuote');
    const indent = this.indentFor(ctx.width);
    const res = this.inner.place({
      ...ctx,
      structParent: this.st.elem ?? ctx.structParent,
      x: ctx.x + indent,
      width: ctx.width - indent,
    });
    if (res.drew && this.bar) this.paintBar(ctx, res.usedHeight, res.remainder !== null);
    // (kk3q) Reported once something drew, never from `measure`.
    if (res.drew && indent < this.indent) this.onCompromise?.('squeezed');
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null
        : new QuotedElement(res.remainder, this.indent, this.bar, this.continues,
          this.barExtend, 0, this.spaceAfter, undefined, this.st),
      // A continuation carries no `clear`: the quote already cleared once.
    };
  }

  /** The bar covers this element's band plus the gap that follows it, so a quote
   *  of several blocks reads as one continuous rule rather than a dashed column.
   *  Three bounds: the LAST block of a quote has no following gap to cover (its
   *  bar would otherwise run on past the quote into the next element), an element
   *  that overflowed has nothing after it in this column either, and the painted
   *  bottom never passes the region's own bottom edge. */
  private paintBar(ctx: PlaceContext, used: number, split: boolean): void {
    const b = this.bar!;
    if (!(b.width > 0)) return;
    const extend = split || !this.continues
      ? 0 : this.barExtend + (ctx.paragraphSpacing ?? 0);
    const bottom = Math.max(ctx.top - used - extend, ctx.top - ctx.availHeight);
    const h = ctx.top - bottom;
    if (!(h > 0)) return;
    paintDecoration(ctx, fillRect(ctx.x + b.offset, bottom, b.width, h, b.color));
  }
}

/** A paragraph's left/right indent (`m2fp.5`): the content box shifted right by
 *  `left` and narrowed by `left + right`, through ONE `insetScale` factor so an
 *  indent wider than the column squeezes rather than driving the width to zero
 *  (`e1bp`). Forwards everything the wrapped element owns, as `QuotedElement`
 *  does, so spacing, keep-with-next and compromise reporting read through it. */
class IndentElement implements FlowElement {
  constructor(
    private readonly inner: FlowElement,
    private readonly left: number,
    private readonly right: number,
  ) {}

  get spaceBefore(): number | undefined { return this.inner.spaceBefore; }
  get spaceAfter(): number | undefined { return this.inner.spaceAfter; }
  get clear(): FlowClear | undefined { return this.inner.clear; }
  get keepWithNextEligible(): boolean | undefined { return this.inner.keepWithNextEligible; }
  get keepWithNext(): boolean | undefined { return this.inner.keepWithNext; }
  get onCompromise(): ((how: Compromise) => void) | undefined { return this.inner.onCompromise; }
  set onCompromise(fn: ((how: Compromise) => void) | undefined) { this.inner.onCompromise = fn; }

  /** ONE factor for both edges, read by measure and place alike. */
  private scale(width: number): number { return insetScale(width, this.left + this.right); }

  noteRefs(): NoteRef[] { return this.inner.noteRefs?.() ?? []; }
  headingSlot(): HeadingSlot | undefined { return this.inner.headingSlot?.(); }

  measure(ctx: MeasureContext): MeasureResult {
    const k = this.scale(ctx.width);
    return this.inner.measure?.({ width: ctx.width - (this.left + this.right) * k, availHeight: ctx.availHeight, indentScale: k,
      tabOrigin: (ctx.tabOrigin ?? 0) + this.left * k })
      ?? { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    const k = this.scale(ctx.width);
    const res = this.inner.place({
      ...ctx, x: ctx.x + this.left * k, width: ctx.width - (this.left + this.right) * k, indentScale: k,
      tabOrigin: (ctx.tabOrigin ?? 0) + this.left * k,
    });
    // Reported once something drew, never from `measure` (kk3q).
    if (res.drew && k < 1) this.onCompromise?.('squeezed');
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null : new IndentElement(res.remainder, this.left, this.right),
    };
  }
}

/** Wrap each element in a left/right indent; the elements unchanged when both
 *  are 0, which is what keeps every caller that states no indent byte-identical. */
export function indented(els: FlowElement[], left: number, right: number): FlowElement[] {
  if (left === 0 && right === 0) return els;
  return els.map((e) => new IndentElement(e, left, right));
}

/** Build a block quote from already-built child elements: each is indented and
 *  gains a gutter bar. Nests — pass the result of one `quote` as the `blocks` of
 *  another. The builder behind `Flow.AddQuote`. */
export function quote(blocks: FlowElement[], options: FlowQuoteOptions = {}): FlowElement[] {
  if (!Array.isArray(blocks)) throw new TypeError('quote blocks must be an array');
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null || typeof (b as FlowElement).place !== 'function')
      throw new TypeError('each quote block must be a FlowElement (see the flow builders)');
  }
  const indent = nonNegative(options.indent, 18, 'indent');
  let bar: ResolvedBar | undefined;
  if (options.bar !== false) {
    const b = options.bar ?? {};
    if (typeof b !== 'object' || b === null || Array.isArray(b))
      throw new TypeError('bar must be an object or false');
    bar = {
      width: nonNegative(b.width, 3, 'bar.width'),
      color: b.color === undefined ? QUOTE_BAR_COLOR : checkColor('bar.color', b.color),
      offset: nonNegative(b.offset, 0, 'bar.offset'),
    };
  }
  const { spaceBefore, spaceAfter } = normalizeSpacing(options);
  const clear = normalizeClear(options.clear);
  if (blocks.length === 0) return [];

  // One holder for the whole quote — see QuoteStruct.
  const st: QuoteStruct = {};
  return blocks.map((inner, i) => {
    const last = i === blocks.length - 1;
    // What the engine will insert after this child, minus its own paragraphSpacing
    // (which the element reads from its PlaceContext at draw time).
    const extend = last ? 0 : (inner.spaceAfter ?? 0) + (blocks[i + 1].spaceBefore ?? 0);
    return new QuotedElement(
      inner, indent, bar, !last, extend,
      i === 0 ? spaceBefore + (inner.spaceBefore ?? 0) : (inner.spaceBefore ?? 0),
      last ? spaceAfter + (inner.spaceAfter ?? 0) : (inner.spaceAfter ?? 0),
      i === 0 ? clear : undefined,
      st,
    );
  });
}
