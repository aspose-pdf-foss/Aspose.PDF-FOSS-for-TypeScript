/** The styled box tree to a flat list of Flow elements.
 *
 *  This module owns the MAPPING and nothing else: it knows about columns,
 *  rects and pagination not at all. Both consumers — Flow's column engine and
 *  flowplace.ts's rect placer — take the FlowElement[] it returns, which is
 *  what makes zch2.5's three entry points cost one implementation. mdflow.ts
 *  is the same shape for the same reason.
 *
 *  Invariant: it does NOT import document.ts or page.ts. `resolveFamily` is
 *  an ARGUMENT — ComputedStyle.fontFamily is a list of NAMES and TextRun.font
 *  is an AuthoringFont, and bridging them needs Document.LoadFontByName. The
 *  seam cssbox.ts, cssinline.ts and cssresolve.ts already take.
 *
 *  Invariant: resolution happens at BUILD time, against a width the caller
 *  supplies — NOT at place() time, which zch2.3's design proposed. Three call
 *  sites read spaceBefore before place() ever runs (flowplace.ts:63,
 *  flow.ts:1298, and flow.ts:1330's keep-with-next lookahead, which reads the
 *  NEXT element's), so a gap computed inside place() can never reach the
 *  engine. Every zch2.5 entry point has a width: a Flow knows its column
 *  width, page.AddHtml is given a rect.
 *
 *  Invariant: the collapsed gap goes ENTIRELY in spaceBefore, with every
 *  spaceAfter zero. flow.ts adds `spaceAfter + paragraphSpacing +
 *  spaceBefore` rather than collapsing, so that reproduces the collapsed
 *  result exactly with no change to Flow. THE CALLER MUST PLACE WITH
 *  `paragraphSpacing: 0`, or a constant is added between every pair.
 *
 *  Invariant: CSS px -> points (x 0.75) happens HERE and nowhere else — and
 *  it includes every TextRun.fontSize, which cssinline.ts emits in px because
 *  it reads ComputedStyle.fontSize directly. Miss that one and all text
 *  renders 33% too large, which reads as a style choice rather than a fault.
 *
 *  Invariant: a construct that does not render names itself in `skipped` and
 *  still contributes what text it has — svgdraw.ts's rule, which zch2.7
 *  formalizes. Float PLACEMENT is zch2.10's and an image sharing its line with
 *  text is zch2.11's; each is reported rather than silently dropped.
 *
 *  Invariant: a table's CAPTION is emitted BEFORE the table as ordinary block
 *  content. TableBuilder has no caption vocabulary, so the alternative is
 *  losing its text.
 *
 *  Note: the root box's escaped top margin is DROPPED. `body { margin: 8px }`
 *  collapses up and out under rule 2, and both engines drop spaceBefore above
 *  the first element anyway. Consistent with Flow, a divergence from a
 *  browser. */

import type { HtmlDocument, HtmlElement } from './htmldom.js';
import type { ComputedStyle, UnsupportedDeclaration } from './cssprop.js';
import type { BoxNode } from './cssbox.js';
import { buildBoxes } from './cssbox.js';
import type { ResolvedBox } from './cssresolve.js';
import { resolveBoxes } from './cssresolve.js';
import { collapseMargins } from './cssmargin.js';
import type { AtomicInline, FamilyResolver } from './cssinline.js';
import type { TextRun } from './textdecor.js';
import { decodeDataUri } from './datauri.js';
import { imageSize } from './imageembed.js';
import { fixedPx } from './cssvalue.js';
import type { NotRendered } from './htmlreport.js';
import type { Undrawable } from './textcoverage.js';
import type { FloatContent } from './flowelement.js';
import type { BuiltSvg } from './svgembed.js';
import { serializeSvg } from './svgserialize.js';
import { svgFigure } from './cssframe.js';
import { floatElement } from './flowfloat.js';
import { textExtents } from './textextents.js';
import type { FlowClear, FlowElement } from './flowelement.js';
import {
  heading, image, list, paragraph, type FlowAtomic,
  type FlowListItem, type FlowParagraphOptions,
} from './flow.js';
import { frameBoxes, type BoxFrame, type FrameEdge } from './cssframe.js';
import { buildTable } from './csstable.js';
import { table } from './flowtable.js';

/** A CSS px is 1/96 in and a point 1/72, so a px is 0.75pt. */
export const PT_PER_PX = 0.75;

/** CSS px to points. The ONE place this conversion happens. @internal */
const pt = (px: number): number => px * PT_PER_PX;

export interface CssFlowOptions {
  /** The containing-block width, IN POINTS — what the caller will place into.
   *  Divided by PT_PER_PX on the way into resolveBoxes, which works in px. */
  width: number;
  /** Turns a CSS family list into the four faces TextRun.font needs.
   *  zch2.5 supplies the real resolver. */
  resolveFamily: FamilyResolver;
  /** Supply the bytes for an `<img src>` that is not a `data:` URI. Returning
   *  undefined reports the image in `skipped`; the rest still renders. */
  resolveImage?: (src: string, alt: string) => Uint8Array | undefined;
  /** Turns a float box's elements into a FloatContent. INJECTED because the
   *  adapter must capture a Document and this module is a pure leaf —
   *  htmlflow.ts supplies it, exactly as it supplies resolveFamily. Omitted:
   *  floats lay out in flow, which is the pre-zch2.10 behaviour. */
  makeFloat?: (
    elements: FlowElement[], width: number, spacing: number,
    onDegraded?: () => void,
  ) => FloatContent;
  /** Import an inline <svg>'s markup as a Form XObject. INJECTED because the
   *  importer needs a Document and this module is a pure leaf — htmlflow.ts
   *  supplies it, exactly as it supplies resolveFamily, resolveImage and
   *  makeFloat. Called at BUILD time, which is what lets the importer's report
   *  reach the one AddHtml hands back. Returns undefined when the import
   *  failed; omitted, an inline <svg> is reported and draws nothing, which is
   *  the pre-zch2.12 behaviour. */
  renderSvg?: (markup: string, size: [number, number]) => BuiltSvg | undefined;
  /** Placement-time reports (`zch2.16`). Separate from `skipped`, which is
   *  handed back at BUILD time — a scale, an overflow and a float degrade are
   *  all decided by the ENGINE, after this module has returned. */
  onNotRendered?: (r: NotRendered) => void;
}

export interface CssFlowResult {
  /** Ready for a Flow or for placeElements — place with `paragraphSpacing: 0`,
   *  or a constant is added between every pair of elements. */
  elements: FlowElement[];
  /** Every construct that did not render as the source specified, in report
   *  order. `kind` separates `dropped` (nothing drawn) from `degraded`
   *  (drawn, but not as specified); `htmlreport.describe` gives the flat
   *  string form for a caller that only logs.
   *
   *  ORDER is by PHASE, then document order within a phase: everything found
   *  while BUILDING boxes precedes everything found while LOWERING them,
   *  because each walks the whole tree. A single global document order would
   *  need a preorder index on every element carried on every record, for a
   *  guarantee no caller has asked for. */
  skipped: NotRendered[];
  /** Passed through from the cascade and the box model, for zch2.7. */
  unsupported: UnsupportedDeclaration[];
}

/** @internal Everything the per-box builders share. */
interface Ctx {
  skipped: NotRendered[];
  unsupported: UnsupportedDeclaration[];
  resolveImage?: (src: string, alt: string) => Uint8Array | undefined;
  makeFloat?: (
    elements: FlowElement[], width: number, spacing: number,
    onDegraded?: () => void,
  ) => FloatContent;
  renderSvg?: (markup: string, size: [number, number]) => BuiltSvg | undefined;
  /** Placement-time reports (`zch2.16`). Separate from `skipped`, which is
   *  handed back at BUILD time — see the spec's Decision 7. */
  onNotRendered?: (r: NotRendered) => void;
  /** The containing width in px, for the same-side stacking report. */
  containingWidthPx: number;
  /** Widest float so far on each side, in px — see the same-side rule. */
  lastFloat?: { left?: number; right?: number };
}

/** The image element for a lone atomic, or null when its bytes cannot be had
 *  or decoded. Reported by the caller either way. */
function imageElement(
  a: AtomicInline, widthPx: number, spaceBefore: number, c: Ctx,
): FlowElement[] | null {
  const src = a.el.attrs.get('src') ?? '';
  const alt = a.el.attrs.get('alt') ?? '';
  const data = decodeDataUri(src) ?? c.resolveImage?.(src, alt);
  if (data === undefined) return null;
  try {
    // Attributed to the <img> itself rather than to the block that holds it
    // (`zch2.16`): a lone image is lowered by its CONTAINER's mapBoxInner, so
    // without this the scale would be reported against the enclosing block.
    return attribute(image(data, {
      width: pt(widthPx),
      alt: alt !== '' ? alt : undefined,
      spaceBefore,
    }), a.el, c);
  } catch {
    // buildImageXObject rejects anything that is not JPEG or PNG. The report
    // has to survive that rather than letting the throw escape a mapper whose
    // whole contract is that damage is a value.
    return null;
  }
}

/** The CSS used size of an `<img>`, in POINTS.
 *
 *  Stated width/height win; otherwise the intrinsic pixel size is read as CSS
 *  px, with the aspect preserved when only one is stated. The `x 0.75` px->pt
 *  conversion happens HERE and nowhere else, which is CLAUDE.md's rule. */
function atomicBox(
  a: AtomicInline, data: Uint8Array,
): { width: number; height: number } | undefined {
  const nat = imageSize(data);
  if (nat === undefined || nat.width <= 0 || nat.height <= 0) return undefined;
  const s = a.style;
  const wPx = s.width === 'auto' ? undefined : fixedPx(s.width);
  const hPx = s.height === 'auto' ? undefined : fixedPx(s.height);
  const aspect = nat.height / nat.width;
  let w = wPx ?? (hPx !== undefined ? hPx / aspect : nat.width);
  let h = hPx ?? (wPx !== undefined ? wPx * aspect : nat.height);
  if (!(w > 0) || !(h > 0)) { w = nat.width; h = nat.height; }
  return { width: pt(w), height: pt(h) };
}

/** zch2.11 implements these three and nothing else; cssinline.ts reports any
 *  other value, so mapping it to baseline here is a fallback rather than a
 *  silent substitution. */
const ALIGN_OF: Record<string, 'baseline' | 'top' | 'bottom'> = {
  baseline: 'baseline', top: 'top', bottom: 'bottom',
};

/** Every atomic that resolves, as a FlowAtomic; the rest are reported.
 *
 *  BYTES reach flow.ts, never a PdfStream — that is what keeps this module's
 *  rule of touching no PDF object module. */
function atomicsOf(
  content: { runs: TextRun[]; atomics: AtomicInline[] }, c: Ctx,
): FlowAtomic[] {
  const out: FlowAtomic[] = [];
  for (const a of content.atomics) {
    const src = a.el.attrs.get('src') ?? '';
    const alt = a.el.attrs.get('alt') ?? '';
    const data = decodeDataUri(src) ?? c.resolveImage?.(src, alt);
    const box = data === undefined ? undefined : atomicBox(a, data);
    if (data === undefined || box === undefined) {
      c.skipped.push({ el: a.el, kind: 'dropped', construct: 'image', detail: src });
      continue;
    }
    out.push({
      beforeRun: a.beforeRun, data, width: box.width, height: box.height,
      align: ALIGN_OF[a.style.verticalAlign] ?? 'baseline',
    });
  }
  return out;
}

/** Is this inline content ONE atomic and nothing else that draws?
 *
 *  MEANINGFUL matters: cssinline.ts filters only `text !== ''`, so
 *  `<p>\n  <img>\n</p>` arrives with whitespace runs either side of the
 *  atomic, and a naive "no runs" test would report the commonest formatting
 *  of an image in real markup. mdflow.ts's `loneImage` says the same thing as
 *  "ignoring surrounding whitespace". */
function loneAtomic(
  content: { runs: TextRun[]; atomics: AtomicInline[] },
): AtomicInline | null {
  if (content.atomics.length !== 1) return null;
  return content.runs.every((r) => r.text.trim() === '') ? content.atomics[0] : null;
}


/** height / width from a `viewBox`, or undefined when there is none to read. */
function svgAspect(el: HtmlElement): number | undefined {
  const vb = el.attrs.get('viewBox');
  if (vb === undefined) return undefined;
  const n = vb.trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || !n.every((v) => Number.isFinite(v))) return undefined;
  return n[2] > 0 && n[3] > 0 ? n[3] / n[2] : undefined;
}

/** A `width`/`height` ATTRIBUTE on an `<svg>`, in px; a percentage resolves
 *  against the containing block, which is what Chrome does — measured. */
function svgAttrPx(el: HtmlElement, which: 'width' | 'height', cw: number): number | undefined {
  const v = el.attrs.get(which);
  if (v === undefined) return undefined;
  const pct = /^\s*([0-9.]+)\s*%\s*$/.exec(v);
  if (pct) return (parseFloat(pct[1]) / 100) * cw;
  const f = parseFloat(v);
  return Number.isFinite(f) && f > 0 ? f : undefined;
}

/** The CSS used size of an inline `<svg>`, in POINTS.
 *
 *  MEASURED against Chrome/152 — the table in
 *  docs/superpowers/specs/2026-09-02-inline-svg-design.md. CSS wins; then the
 *  element's own width/height attributes; then, with a viewBox to give an
 *  aspect ratio, FILL the available width and take the height from it; then
 *  300x150.
 *
 *  The viewBox row is the counter-intuitive one and the reason this is measured
 *  rather than reasoned about: `<svg viewBox="0 0 100 50">` with no width or
 *  height is 800x400 in an 800px container, NOT a small default box. The
 *  300x150 default applies only when there is no aspect ratio to work from. */
function svgBox(a: AtomicInline, availPx: number): { width: number; height: number } {
  const s = a.style;
  const aspect = svgAspect(a.el);
  const cssW = s.width === 'auto' ? undefined : fixedPx(s.width);
  const cssH = s.height === 'auto' ? undefined : fixedPx(s.height);
  const w = cssW ?? svgAttrPx(a.el, 'width', availPx)
    ?? (aspect !== undefined ? availPx : 300);
  const h = cssH ?? svgAttrPx(a.el, 'height', availPx)
    ?? (aspect !== undefined ? w * aspect : 150);
  return { width: pt(Math.max(0, w)), height: pt(Math.max(0, h)) };
}

/** The figure for a lone inline `<svg>`, or null when it could not be imported.
 *  Reported by the caller either way. */
function svgElement(
  a: AtomicInline, availPx: number, spaceBefore: number, c: Ctx,
): FlowElement[] | null {
  if (c.renderSvg === undefined) return null;
  const { width, height } = svgBox(a, availPx);
  if (!(width > 0) || !(height > 0)) return null;
  const built = c.renderSvg(serializeSvg(a.el), [width, height]);
  if (built === undefined) return null;
  for (const nameOf of built.skipped) {
    c.skipped.push({ el: a.el, kind: 'degraded', construct: 'svg', detail: nameOf });
  }
  // Rasterizing draws correctly but is resolution-bound and its text stops
  // being extractable — "drawn, but not as specified", which is `degraded`.
  for (const nameOf of built.rasterized) {
    c.skipped.push({ el: a.el, kind: 'degraded', construct: 'svg', detail: nameOf });
  }
  const fig = svgFigure(built, [width, height]);
  return [{ ...fig, spaceBefore, spaceAfter: 0 }];
}
/** A colour that paints nothing is absent, not black at alpha 0. */
function paintColor(c: ComputedStyle['backgroundColor']): [number, number, number] | undefined {
  return c.a > 0 ? [c.rgb[0], c.rgb[1], c.rgb[2]] : undefined;
}

/** An edge whose style is `none`/`hidden` has a USED width of 0 — CSS 2.1
 *  §8.5.3, the rule cssresolve.ts already applies to the insets. The initial
 *  border-style is `none` and the initial width `medium` (3px), so without
 *  this every box in every document grows a 3px border. */
function edgeOf(
  width: number, style: ComputedStyle['borderTopStyle'], color: ComputedStyle['borderTopColor'],
): FrameEdge | undefined {
  if (style === 'none' || style === 'hidden' || !(width > 0)) return undefined;
  const c = paintColor(color);
  return c === undefined ? undefined : { width: pt(width), color: c };
}

/** The frame for one resolved box, in POINTS. */
function frameOf(r: ResolvedBox): BoxFrame {
  const s = r.box.style;
  return {
    marginLeft: pt(r.marginLeft),
    marginRight: pt(r.marginRight),
    insetLeft: pt(r.insetLeft),
    insetRight: pt(r.insetRight),
    insetTop: pt(r.insetTop),
    insetBottom: pt(r.insetBottom),
    background: paintColor(s.backgroundColor),
    borderTop: edgeOf(s.borderTopWidth, s.borderTopStyle, s.borderTopColor),
    borderRight: edgeOf(s.borderRightWidth, s.borderRightStyle, s.borderRightColor),
    borderBottom: edgeOf(s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor),
    borderLeft: edgeOf(s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor),
    minHeight: pt(r.minHeight),
  };
}

/** CSS `start`/`end` are writing-mode relative; this stack is LTR only. */
function alignOf(a: ComputedStyle['textAlign']): FlowParagraphOptions['align'] {
  if (a === 'start') return 'left';
  if (a === 'end') return 'right';
  return a;
}

/** Baseline-to-baseline distance in POINTS, or undefined for the builder's
 *  own 1.2x default. A NUMBER line-height multiplies the element's own font
 *  size; a px one is already absolute. */
function leadingOf(s: ComputedStyle): number | undefined {
  if (s.lineHeight === 'normal') return undefined;
  if ('number' in s.lineHeight) return pt(s.lineHeight.number * s.fontSize);
  return pt(s.lineHeight.px);
}

/** Every run's fontSize crosses the px -> pt boundary here. cssinline.ts
 *  emits px because it reads ComputedStyle.fontSize directly. */
function scaleRuns(runs: TextRun[]): TextRun[] {
  return runs.map((r) => (
    r.fontSize === undefined ? r : { ...r, fontSize: pt(r.fontSize) }));
}

function clearOf(c: ComputedStyle['clear']): FlowClear | undefined {
  return c === 'none' ? undefined : c;
}

/** The heading level an element states, or 0. A DOM fact rather than a CSS
 *  one: no computed property says "this is a heading". */
function headingLevel(el: HtmlElement | null): number {
  if (el === null || el.ns !== 'html') return 0;
  const m = /^h([1-6])$/.exec(el.name);
  return m === null ? 0 : Number(m[1]);
}

/** The word-wrapped element for one inline formatting context.
 *
 *  A heading goes through `heading()` with the cascade's font and size passed
 *  EXPLICITLY, so the builder's own defaults (Helvetica-Bold, and
 *  24/18/14/12/10/8 by level) never double-apply on top of the UA sheet's.
 *  What that buys is exactly what `paragraph()` cannot give: /H1../H6 in a
 *  tagged flow, and keepWithNextEligible so a heading is not orphaned at the
 *  foot of a column. Both are SILENT losses — the rendering is identical. */
function textElement(
  runs: TextRun[], el: HtmlElement | null, style: ComputedStyle,
  atomics: FlowAtomic[] | undefined, c: Ctx,
): FlowElement[] {
  // Blame is at BLOCK granularity: the builder sees the <p>, not a <span>
  // inside it. That is the accepted cost of one detection site, and `detail`
  // carries the actionable half — which characters were lost.
  const onUndrawable = (u: Undrawable): void => {
    c.skipped.push({
      el, kind: u.all ? 'dropped' : 'degraded', construct: 'text', detail: u.lost,
    });
  };
  const opts: FlowParagraphOptions = {
    align: alignOf(style.textAlign),
    leading: leadingOf(style),
    atomics: atomics !== undefined && atomics.length > 0 ? atomics : undefined,
    onUndrawable,
  };
  const level = headingLevel(el);
  if (level === 0) return paragraph(runs, opts);
  return heading(level, runs, {
    ...opts,
    font: runs[0]?.font,
    fontSize: runs[0]?.fontSize,
  });
}

/** Map one box, floating it when it says so.
 *
 *  A float box lowers to exactly ONE wrapper element: a marker on the first of
 *  several would leave the rest in the queue to be placed a second time. That
 *  the wrapper holds a group is allowed because a float never SPLITS — see
 *  flowfloat.ts. */
function mapBox(r: ResolvedBox, spaceBefore: number, c: Ctx): FlowElement[] {
  const els = mapBoxInner(r, spaceBefore, c);
  const side = r.box.float;
  if (side === 'none' || els.length === 0 || c.makeFloat === undefined)
    return attribute(els, r.box.el, c);
  // What the float physically occupies: border and padding exclude space too.
  const borderBoxWidth = r.contentWidth + r.insetLeft + r.insetRight;
  // CSS puts two same-side floats side by side when there is room; Flow stacks
  // them, because ActiveFloat.band is one width from the column edge and
  // insetsAt takes the MAX per side — side-by-side needs a SUM, a change to the
  // band model that AddFloatBox shares. Widths resolve at BUILD time, so the
  // divergence is knowable right here.
  const prev = c.lastFloat?.[side];
  if (prev !== undefined && prev + borderBoxWidth <= c.containingWidthPx) {
    c.skipped.push({ el: r.box.el, kind: 'degraded', construct: 'float', detail: side });
  }
  (c.lastFloat ??= {})[side] = borderBoxWidth;
  // spacing is the float's own margin on the CHANNEL side: the engine excludes
  // width + spacing, so a float with no margin sits flush against the text.
  const spacing = pt(side === 'left' ? r.marginRight : r.marginLeft);
  // The engine may call back MORE THAN ONCE for one box: after a float
  // degrades it places like any other element, and a retry in the next column
  // re-enters the float branch. One box is one record, so the de-duplication
  // lives here — the engine must not have to know.
  const content = c.makeFloat(els, pt(borderBoxWidth), spacing,
    once(c, { el: r.box.el, kind: 'degraded', construct: 'float', detail: side }));
  return attribute([floatElement(els, side, content, spaceBefore, 0)], r.box.el, c);
}

/** Give every element this box produced a channel back for the two compromises
 *  the ENGINE decides (`zch2.16`): a scale and an overflow cannot be predicted
 *  here, since this module knows the container WIDTH and never the column
 *  HEIGHT.
 *
 *  Only an element NOBODY has claimed is attributed, and that is the whole
 *  rule: `mapBox` recurses, so a child's elements are already tagged by the
 *  time its ancestors run — assigning unconditionally lets the outermost box
 *  win and every compromise in the document is reported against `<html>`. */
function attribute(
  els: FlowElement[], el: HtmlElement | null, c: Ctx,
): FlowElement[] {
  const scaled = once(c, {
    el, kind: 'degraded', construct: 'image', detail: 'scaled-to-fit',
  });
  const overflowed = once(c, { el, kind: 'degraded', construct: 'overflow' });
  for (const el of els) {
    if (el.onCompromise !== undefined) continue;
    el.onCompromise = (how) => { (how === 'scaled' ? scaled : overflowed)(); };
  }
  return els;
}

/** A one-shot report: the engine may fire a callback more than once for one
 *  box (a retry after a column advance does), and one box is one record. */
function once(c: Ctx, r: NotRendered): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    c.onNotRendered?.(r);
  };
}

/** Map one box to the elements its subtree produces, already framed. */
function mapBoxInner(r: ResolvedBox, spaceBefore: number, c: Ctx): FlowElement[] {
  const box = r.box;

  if (box.kind === 'table') {
    const els: FlowElement[] = [];
    // A caption is ordinary block content emitted BEFORE the table:
    // TableBuilder has no caption vocabulary, and dropping it loses its text.
    // Resolved HERE rather than through mapSiblings so the table's own
    // collapsed gap lands on whichever of the two comes first; mapSiblings
    // zeroes the gap above its first box, which would drop it.
    if (box.caption !== null) {
      const [cr] = resolveBoxes([box.caption], r.contentWidth);
      els.push(...mapBox(cr, spaceBefore, c));
    }
    const built = buildTable(box, { toPt: pt, scaleRuns, skipped: c.skipped });
    // A table with no rows builds nothing, and the caller carries its gap
    // forward exactly as it does for any other box that produced no element.
    if (built !== null) {
      els.push(...table(built, {
        // A cell never passes through the shared flow builders, so `table()`
        // walks them itself — one site, shared with Markdown and a hand-built
        // Flow, rather than a copy of the walk in each mapper.
        onUndrawable: (u) => {
          c.skipped.push({
            el: box.el, kind: u.all ? 'dropped' : 'degraded',
            construct: 'text', detail: u.lost,
          });
        },
        width: pt(r.contentWidth),
        spaceBefore: els.length === 0 ? spaceBefore : 0,
        clear: clearOf(box.style.clear),
      }));
    }
    return els;
  }

  const style = box.style;
  const spacing = { spaceBefore, clear: clearOf(style.clear) };

  if (box.content.kind === 'inline') {
    // A LONE image is a figure and renders. One sharing its line with text is
    // zch2.11's: layoutRuns cannot place an atomic inside a line, so the text
    // renders and the picture is reported.
    const lone = loneAtomic(box.content);
    if (lone !== null && lone.kind === 'svg') {
      // A lone inline <svg> is a figure and renders through the SVG importer
      // (zch2.12). One sharing its line with text is reported below, the same
      // rule zch2.11 applies to an image.
      const els = svgElement(lone, r.contentWidth, spaceBefore, c);
      if (els !== null) return frameBoxes(els, frameOf(r), spacing);
      c.skipped.push({ el: lone.el, kind: 'dropped', construct: 'svg' });
      return [];
    }
    if (lone !== null) {
      const els = imageElement(lone, r.contentWidth, spaceBefore, c);
      if (els !== null) return frameBoxes(els, frameOf(r), spacing);
      // It did not resolve. Report it HERE and fall through to the text with
      // NO atomics: atomicsOf would ask the resolver for the same src a
      // second time, and a caller that counts its calls (or fetches) would
      // see the work done twice.
      c.skipped.push({
        el: lone.el, kind: 'dropped', construct: 'image',
        detail: lone.el.attrs.get('src') ?? '',
      });
      const loneRuns = scaleRuns(box.content.runs);
      if (loneRuns.length === 0) return [];
      return frameBoxes(textElement(loneRuns, box.el, style, undefined, c), frameOf(r), spacing);
    }
    // Not a lone image: each atomic that resolves rides the paragraph as an
    // inline box (zch2.11), and only the ones we cannot resolve are reported.
    const atomics = atomicsOf(box.content, c);
    const runs = scaleRuns(box.content.runs);
    if (runs.length === 0 && atomics.length === 0) return [];
    return frameBoxes(
      textElement(runs, box.el, style, atomics, c), frameOf(r), spacing);
  }

  // A block container: its children flatten, each wrapped in THIS box's frame.
  const kids = mapSiblings(box.content.children, r.contentWidth, c);
  return frameBoxes(kids, frameOf(r), spacing);
}

/** CSS list-style-type values that NUMBER rather than bullet. */
const ORDERED_TYPES = new Set([
  'decimal', 'decimal-leading-zero', 'lower-alpha', 'upper-alpha',
  'lower-roman', 'upper-roman', 'lower-latin', 'upper-latin',
]);

/** The end of the run of consecutive list-item boxes starting at `i`. */
function listRunEnd(resolved: ResolvedBox[], i: number): number {
  let j = i;
  while (j < resolved.length && resolved[j].box.kind === 'list-item') j += 1;
  return j;
}

/** An `<ol start>` on the run's shared parent element, or 1. */
function listStart(first: ResolvedBox): number {
  const parent = first.box.el?.parent;
  if (parent === null || parent === undefined || parent.kind !== 'element') return 1;
  const raw = parent.attrs.get('start');
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : 1;
}

/** Map a RUN of consecutive list-item boxes to ONE list().
 *
 *  A run rather than an item: `list()` owns the ordinal counter, so one call
 *  per item restarts it and every marker reads "1.". Markers, the auto indent
 *  and /L > /LI > /LBody all come free, and an item's own content goes
 *  through the SAME builders a standalone box would — which is what makes a
 *  nested list arrive as an ordinary element in `blocks` and need no second
 *  path. */
function mapList(
  run: ResolvedBox[], gaps: number[], spaceBefore: number, c: Ctx,
): FlowElement[] {
  const first = run[0];
  const style = first.box.style;
  const items: FlowListItem[] = run.map((r, i) => {
    // gaps[0] belongs to the whole list; the later ones space the items.
    const item: FlowListItem = { spaceBefore: i === 0 ? 0 : pt(gaps[i]) };
    const box = r.box;
    // A table cannot carry display:list-item, so this run holds BlockBoxes
    // only; the guard narrows the type rather than claiming anything.
    if (box.kind === 'table') { item.text = ''; return item; }
    if (box.content.kind === 'inline') {
      for (const a of box.content.atomics) {
        c.skipped.push({
          el: a.el, kind: 'dropped', construct: 'image',
          detail: a.el.attrs.get('src') ?? '',
        });
      }
      const runs = scaleRuns(box.content.runs);
      // An item must carry `text` or `blocks`; '' is the empty-item spelling.
      item.text = runs.length > 0 ? runs : '';
      return item;
    }
    // `blocks` ALONE — setting `text: ''` beside it emits an extra empty text
    // element which then owns the marker, so an item opening with a nested
    // list would draw its marker on a blank line.
    const blocks = mapSiblings(box.content.children, r.contentWidth, c);
    if (blocks.length === 0) item.text = '';
    else item.blocks = blocks;
    return item;
  });
  return list(items, {
    ordered: ORDERED_TYPES.has(style.listStyleType),
    start: listStart(first),
    fontSize: pt(style.fontSize),
    align: alignOf(style.textAlign),
    spaceBefore,
  });
}

/** Intrinsic widths of a box's own content, in CSS px, for a float's
 *  shrink-to-fit. `resolveBoxes` has accepted this since zch2.3 and nothing
 *  passed one, so an auto-width float came out FULL WIDTH — excluding the whole
 *  channel and indistinguishable from ordinary flow.
 *
 *  textExtents returns POINTS and resolveBoxes works in px, so the result is
 *  divided by PT_PER_PX. Backwards, every float is 33% too wide, which reads as
 *  a style choice rather than a fault. */
function measureBox(box: BoxNode): { min: number; max: number } {
  if (box.kind === 'table') return { min: 0, max: 0 };
  if (box.content.kind === 'inline') {
    const runs = box.content.runs;
    const e = textExtents(runs, runs[0]?.font ?? 'Helvetica', runs[0]?.fontSize ?? 12);
    return { min: e.longestWord / PT_PER_PX, max: e.longestLine / PT_PER_PX };
  }
  // A block container takes the max over its children, which is what CSS's
  // shrink-to-fit does.
  let min = 0;
  let max = 0;
  for (const kid of box.content.children) {
    const k = measureBox(kid);
    min = Math.max(min, k.min);
    max = Math.max(max, k.max);
  }
  return { min, max };
}

/** Map a sibling list, resolved against their shared containing width (in px)
 *  and with the collapsed gaps spent as spaceBefore. */
function mapSiblings(boxes: BoxNode[], widthPx: number, c: Ctx): FlowElement[] {
  if (boxes.length === 0) return [];
  const resolved = resolveBoxes(boxes, widthPx, measureBox);
  const gaps = collapseMargins(resolved);
  const out: FlowElement[] = [];

  // A box may produce no element at all — a skipped table, an empty block.
  // Its gap must land on the NEXT box that does, or the space disappears.
  let carry = 0;
  let i = 0;
  while (i < resolved.length) {
    carry += gaps[i];
    let els: FlowElement[];
    if (resolved[i].box.kind === 'list-item') {
      // A RUN, not an item: one list() per run is what keeps the ordinal
      // counter continuous. Per item, every marker reads "1.".
      const end = listRunEnd(resolved, i);
      els = mapList(resolved.slice(i, end), gaps.slice(i, end), pt(carry), c);
      i = end;
    } else {
      els = mapBox(resolved[i], pt(carry), c);
      i += 1;
    }
    if (els.length === 0) continue;
    out.push(...els);
    carry = 0;
  }
  return out;
}

/** Lower a parsed HTML document to a flat list of Flow elements.
 *
 *  Named `lowerHtml` rather than `htmlFlowElements` because `htmlflow.ts`
 *  exports the PUBLIC `htmlElements`, which wraps this one with a Document and
 *  a real font resolver. Two names one word apart, over the same argument and
 *  return types, is a call the compiler cannot correct. */
export function lowerHtml(
  root: HtmlDocument, options: CssFlowOptions,
): CssFlowResult {
  if (!Number.isFinite(options?.width) || options.width <= 0)
    throw new TypeError('width must be a positive finite number');
  if (typeof options.resolveFamily !== 'function')
    throw new TypeError('resolveFamily must be a function');

  const { boxes, unsupported, report } = buildBoxes(root, options.resolveFamily);
  // The SAME array, so the flow phase appends to what the box phase produced
  // — one list rather than a merge step that could reorder or lose a record.
  // It is `report` in the two pure leaves and `skipped` here, because that is
  // the public field's name; this line is where the two meet.
  const containingWidthPx = options.width / PT_PER_PX;
  const c: Ctx = {
    skipped: report, unsupported, resolveImage: options.resolveImage,
    makeFloat: options.makeFloat, renderSvg: options.renderSvg,
    onNotRendered: options.onNotRendered, containingWidthPx,
  };
  const elements = mapSiblings(boxes, containingWidthPx, c);
  return { elements, skipped: c.skipped, unsupported };
}
