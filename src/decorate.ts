// Page decoration (issue h8s): watermark / header-footer / Bates numbering as an
// ergonomic layer over the stamping primitives. No new rendering primitives —
// text goes through stampText (stamp.ts), images through buildImageXObject
// (imageembed.ts).
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { Matrix } from './text.js';
import { apply, mul } from './text.js';
import { stampText, measureText, type AuthoringFont } from './stamp.js';
import {
  validateDecoration, validateBackground,
  type Decoration, type Background,
} from './textdecor.js';
import { buildImageXObject } from './imageembed.js';
import {
  appendContent, prependContent, ensureOwnResources, ensureOwnSubdict,
  freshKey, registerExtGState, num,
} from './pagecontent.js';
import { enc } from './serialize.js';
import { isStream, type PdfRef } from './types.js';
import { resolvePages } from './pagerange.js';

/** Tokens callers may write in any decoration text. */
const TOKENS = ['page', 'total', 'label', 'bates', 'date', 'time'] as const;

/** A fresh matcher each call: the regex is stateful under /g, so sharing one
 *  module-level instance between matchAll and replace would leak lastIndex. */
const tokenRe = (): RegExp => /\{\{|\{([a-z]+)\}/g;

/** @internal Throw a TypeError for any unknown token in `template`.
 *  `allowBates` is false outside AddBatesNumbering, where no counter is in
 *  scope. Validation is eager — callers scan every template before touching a
 *  page — so a typo like {pages} cannot silently stamp literal text onto 400
 *  pages, and a throwing call leaves the document untouched. */
export function validateTemplate(template: string, allowBates: boolean): void {
  const valid: readonly string[] = TOKENS.filter((t) => t !== 'bates' || allowBates);
  for (const m of template.matchAll(tokenRe())) {
    if (m[1] === undefined) continue; // '{{' escape, not a token
    if (!valid.includes(m[1]))
      throw new TypeError(
        `unknown token {${m[1]}}: valid tokens are ${valid.map((t) => `{${t}}`).join(', ')}`);
  }
}

/** @internal Substitute tokens in `template`. `{{` yields a literal `{`; a bare
 *  `}` is literal (so `{{page}` renders as `{page}`). Assumes the template has
 *  already passed validateTemplate. */
export function resolveTemplate(template: string, values: Record<string, string>): string {
  return template.replace(tokenRe(), (_m, tok: string | undefined) =>
    tok === undefined ? '{' : (values[tok] ?? ''));
}

/** @internal The `{date}`/`{time}` values for one call. Computed once per call,
 *  never per page: a long run must not straddle midnight and stamp two dates. */
export function stampedNow(): { date: string; time: string } {
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
  };
}

/** Where a stamp anchors in the page's visual frame. */
export type StampPosition =
  | 'diagonal' | 'center'
  | 'top-left' | 'top-center' | 'top-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** @internal Every valid StampPosition (drives validation error messages). */
export const POSITIONS: readonly StampPosition[] = [
  'diagonal', 'center',
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

/** @internal The page as the viewer sees it: `M` maps visual-frame coordinates
 *  (origin at the displayed bottom-left, extent VW x VH) into user space, and
 *  `R` is the page's /Rotate. */
export interface VisualFrame {
  M: Matrix;
  VW: number;
  VH: number;
  R: number;
}

/** @internal Build the visual frame for `page` from its CropBox and /Rotate.
 *  /Rotate turns the page clockwise for display, so M is that turn's inverse
 *  (plus the CropBox origin offset). Derived and tabulated in the design spec. */
export function visualFrame(page: Page): VisualFrame {
  const [x0, y0, x1, y1] = page.CropBox;
  const w = x1 - x0, h = y1 - y0;
  const R = page.Rotate;
  switch (R) {
    case 90:  return { M: [0, 1, -1, 0, x0 + w, y0], VW: h, VH: w, R };
    case 180: return { M: [-1, 0, 0, -1, x0 + w, y0 + h], VW: w, VH: h, R };
    case 270: return { M: [0, -1, 1, 0, x0, y0 + h], VW: h, VH: w, R };
    default:  return { M: [1, 0, 0, 1, x0, y0], VW: w, VH: h, R };
  }
}

/** Fraction of the em above the baseline used to optically center a single line
 *  (about half of Helvetica's cap height, 0.7em). */
const CAP_HALF = 0.35;

/** @internal A text stamp's placement in the visual frame: baseline anchor,
 *  the alignment that anchor implies, and the apparent (as-displayed) angle. */
export interface TextAnchor {
  vx: number;
  vy: number;
  align: 'left' | 'center' | 'right';
  angle: number;
}

/** @internal Baseline anchor for `position` in the visual frame. Corner/edge
 *  presets inset by `margin`; a top band drops a further `fontSize` so the
 *  glyphs sit below the margin rather than straddling it. */
export function textAnchor(
  position: StampPosition, f: VisualFrame, margin: number, fontSize: number,
): TextAnchor {
  if (position === 'diagonal' || position === 'center') {
    const angle = position === 'diagonal' ? (Math.atan2(f.VH, f.VW) * 180) / Math.PI : 0;
    return { vx: f.VW / 2, vy: f.VH / 2 - fontSize * CAP_HALF, align: 'center', angle };
  }
  const [band, side] = position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
  return {
    vx: side === 'left' ? margin : side === 'right' ? f.VW - margin : f.VW / 2,
    vy: band === 'top' ? f.VH - margin - fontSize : margin,
    align: side,
    angle: 0,
  };
}

/** @internal An image stamp's placement in the visual frame: the anchor point,
 *  the fraction of the image's own box that sits at it (fx/fy in 0..1), and the
 *  apparent angle. */
export interface ImageAnchor {
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  angle: number;
}

/** @internal Anchor for an image stamp. Mirrors textAnchor, but anchors a box
 *  rather than a baseline: `diagonal`/`center` pin the image's own center so it
 *  rotates about itself. */
export function imageAnchor(
  position: StampPosition, f: VisualFrame, margin: number,
): ImageAnchor {
  if (position === 'diagonal' || position === 'center') {
    const angle = position === 'diagonal' ? (Math.atan2(f.VH, f.VW) * 180) / Math.PI : 0;
    return { vx: f.VW / 2, vy: f.VH / 2, fx: 0.5, fy: 0.5, angle };
  }
  const [band, side] = position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
  return {
    vx: side === 'left' ? margin : side === 'right' ? f.VW - margin : f.VW / 2,
    vy: band === 'top' ? f.VH - margin : margin,
    fx: side === 'left' ? 0 : side === 'right' ? 1 : 0.5,
    fy: band === 'top' ? 1 : 0,
    angle: 0,
  };
}

/** @internal The placement options every decoration shares, already defaulted. */
export interface Placement {
  position: StampPosition;
  margin: number;
  opacity: number;
  /** Explicit apparent angle in degrees CCW; undefined uses the preset's own. */
  rotate?: number;
  font: AuthoringFont;
  /** undefined means "derive it" (diagonal auto-fit, else the 24pt default). */
  fontSize?: number;
  color: [number, number, number];
  underlay: boolean;
  underline?: Decoration;
  strikethrough?: Decoration;
  background?: Background;
}

/** @internal Validate a placement up front, before any page is touched, so a
 *  bad call cannot leave a half-decorated document. Returns `p` unchanged. */
export function normalizePlacement(p: Placement): Placement {
  if (!POSITIONS.includes(p.position))
    throw new TypeError(`position must be one of ${POSITIONS.join(', ')}`);
  if (!Number.isFinite(p.margin) || p.margin < 0)
    throw new TypeError('margin must be a non-negative finite number');
  if (!Number.isFinite(p.opacity) || p.opacity < 0 || p.opacity > 1)
    throw new TypeError('opacity must be in 0..1');
  if (p.rotate !== undefined && !Number.isFinite(p.rotate))
    throw new TypeError('rotate must be a finite number');
  if (p.fontSize !== undefined && (!Number.isFinite(p.fontSize) || p.fontSize <= 0))
    throw new TypeError('fontSize must be a positive finite number');
  if (!Array.isArray(p.color) || p.color.length !== 3 ||
      !p.color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
  validateDecoration('underline', p.underline);
  validateDecoration('strikethrough', p.strikethrough);
  validateBackground('background', p.background);
  return p;
}

/** Fallback size for a non-diagonal text watermark. */
const DEFAULT_WATERMARK_SIZE = 24;

/** @internal The font size for one text stamp: an explicit size wins; a
 *  diagonal watermark auto-fits to ~80% of the page diagonal (width is linear
 *  in size, so one unit measurement gives the scale). */
function fontSizeFor(text: string, p: Placement, f: VisualFrame): number {
  if (p.fontSize !== undefined) return p.fontSize;
  if (p.position !== 'diagonal') return DEFAULT_WATERMARK_SIZE;
  const unit = measureText(text, 1, p.font);
  if (!(unit > 0)) return DEFAULT_WATERMARK_SIZE; // unmeasurable: don't divide by 0
  return (0.8 * Math.hypot(f.VW, f.VH)) / unit;
}

/** @internal Draw one text stamp on `page` at the placement's preset position.
 *  stampText works in user space and bypasses the frame matrix, so the anchor is
 *  mapped through M by hand and the page's /Rotate is *added* to the angle —
 *  that is the counter-rotation that cancels the viewer's clockwise turn. (The
 *  image path composes with M instead and must not add R.) */
export function drawText(doc: Document, page: Page, text: string, p: Placement): void {
  const f = visualFrame(page);
  const fontSize = fontSizeFor(text, p, f);
  const a = textAnchor(p.position, f, p.margin, fontSize);
  const [x, y] = apply(f.M, a.vx, a.vy);
  stampText(doc, page, text, x, y, {
    font: p.font,
    fontSize,
    color: p.color,
    opacity: p.opacity,
    rotate: (p.rotate ?? a.angle) + f.R,
    align: a.align,
    underline: p.underline,
    strikethrough: p.strikethrough,
    background: p.background,
  }, p.underlay ? prependContent : appendContent);
}

/** @internal Token values for page `n`. `needsLabel` gates the /PageLabels
 *  lookup, which re-parses the number tree per call. */
export function tokenValuesFor(
  doc: Document, n: number, total: number,
  now: { date: string; time: string }, needsLabel: boolean,
): Record<string, string> {
  return {
    page: String(n),
    total: String(total),
    label: needsLabel ? doc.PageLabelFor(n - 1) : '',
    date: now.date,
    time: now.time,
  };
}

/** @internal True when `template` actually uses `{label}`. */
export function usesLabel(template: string): boolean {
  return /\{label\}/.test(template);
}

/** @internal Default drawn width for an image stamp, per preset. */
function imageWidthFor(position: StampPosition, f: VisualFrame): number {
  if (position === 'diagonal') return 0.8 * Math.hypot(f.VW, f.VH);
  if (position === 'center') return 0.5 * f.VW;
  return 0.25 * f.VW;
}

/** @internal Place the already-embedded image `imgRef` (intrinsic `iw` x `ih`
 *  pixels) on `page`. Unlike the text path, the image is laid out in the visual
 *  frame and composed with M, which already carries the /Rotate turn — so the
 *  local angle is the apparent angle and R is NOT added. */
function drawImage(
  doc: Document, page: Page, imgRef: PdfRef, iw: number, ih: number,
  p: Placement, width: number | undefined,
): void {
  const f = visualFrame(page);
  const a = imageAnchor(p.position, f, p.margin);
  const w = width ?? imageWidthFor(p.position, f);
  const h = w * (ih / iw); // never scaled anisotropically
  const rad = ((p.rotate ?? a.angle) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);

  // unit square -> w x h -> anchor fraction to the origin -> rotate -> move to
  // the anchor -> visual frame to user space. mul(m, n) applies m then n.
  const scale: Matrix = [w, 0, 0, h, 0, 0];
  const toAnchor: Matrix = [1, 0, 0, 1, -a.fx * w, -a.fy * h];
  const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
  const move: Matrix = [1, 0, 0, 1, a.vx, a.vy];
  const cm = mul(mul(mul(mul(scale, toAnchor), rot), move), f.M);

  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Im');
  xobjs.set(key, imgRef);

  const gsKey = p.opacity < 1 ? registerExtGState(doc, page, p.opacity) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += `${cm.map(num).join(' ')} cm\n/${key} Do\nQ`;
  const body = enc(s);
  if (p.underlay) prependContent(doc, page, body);
  else appendContent(doc, page, body);
}

/** @internal Embed `data` ONCE and place the single shared Image XObject on each
 *  page. Building per page would put one copy of the JPEG in the file per page. */
export function drawImageOnPages(
  doc: Document, pages: Page[], data: Uint8Array, p: Placement, width?: number,
): void {
  const built = buildImageXObject(data);
  if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
  const imgRef = doc.allocObject(built.stream);
  const img = doc.resolve(imgRef);
  if (!isStream(img)) return; // unreachable: buildImageXObject always yields a stream
  const iw = img.dict.get('Width') as number;
  const ih = img.dict.get('Height') as number;
  for (const page of pages) drawImage(doc, page, imgRef, iw, ih, p, width);
}

/** Options for {@link Document.AddWatermark}. Provide exactly one of `text` or
 *  `image`. */
export interface WatermarkOptions {
  /** Watermark text; may contain tokens ({page}, {total}, {label}, {date}, {time}). */
  text?: string;
  /** Watermark image as encoded JPEG or PNG bytes. */
  image?: Uint8Array;
  /** 1-based pages, or a range string like '1-5,8'. Default: every page. */
  pages?: number[] | string;
  /** Positioning preset. Default 'diagonal'. */
  position?: StampPosition;
  /** Constant opacity 0..1. Default 0.3. */
  opacity?: number;
  /** Apparent rotation in degrees CCW; default = the preset's own angle. */
  rotate?: number;
  /** 'underlay' draws behind existing content, 'overlay' on top. Default 'underlay'. */
  mode?: 'overlay' | 'underlay';
  /** Standard-14 face or an AddFont handle. Default 'Helvetica'. */
  font?: AuthoringFont;
  /** Text size in points. Default: auto-fit for 'diagonal', else 24. */
  fontSize?: number;
  /** Fill color, components in 0..1. Default [0.5, 0.5, 0.5]. */
  color?: [number, number, number];
  /** Inset in points for corner/edge presets. Default 36. */
  margin?: number;
  /** Image width in points; default depends on the preset. Ignored for text. */
  width?: number;
  /** Rule below the baseline of the stamped text. Default: none. */
  underline?: Decoration;
  /** Rule through the stamped text. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind the stamped text. Default: none. */
  background?: Background;
}

/** @internal Implementation of {@link Document.AddWatermark}. */
export function addWatermark(doc: Document, opts: WatermarkOptions): void {
  const hasText = typeof opts.text === 'string';
  const hasImage = opts.image !== undefined;
  if (hasText === hasImage)
    throw new TypeError('AddWatermark: provide exactly one of text or image');

  const p = normalizePlacement({
    position: opts.position ?? 'diagonal',
    margin: opts.margin ?? 36,
    opacity: opts.opacity ?? 0.3,
    rotate: opts.rotate,
    font: opts.font ?? 'Helvetica',
    fontSize: opts.fontSize,
    color: opts.color ?? [0.5, 0.5, 0.5],
    underlay: (opts.mode ?? 'underlay') === 'underlay',
    underline: opts.underline,
    strikethrough: opts.strikethrough,
    background: opts.background,
  });
  if (opts.width !== undefined && (!Number.isFinite(opts.width) || opts.width <= 0))
    throw new TypeError('width must be a positive finite number');

  // Everything that can throw runs before the first mutation.
  const pagesArr = doc.Pages;
  const selected = resolvePages(opts.pages, pagesArr.length);
  const template = opts.text ?? '';
  if (hasText) validateTemplate(template, false);

  if (hasImage) {
    drawImageOnPages(doc, selected.map((n) => pagesArr[n - 1]), opts.image!, p, opts.width);
    return;
  }

  const now = stampedNow();
  const needsLabel = usesLabel(template);
  for (const n of selected) {
    const values = tokenValuesFor(doc, n, pagesArr.length, now, needsLabel);
    drawText(doc, pagesArr[n - 1], resolveTemplate(template, values), p);
  }
}

/** One band of a header/footer: up to three independently-positioned cells. */
export interface HeaderFooterBand {
  left?: string;
  center?: string;
  right?: string;
}

/** Options for {@link Document.AddHeaderFooter}. */
export interface HeaderFooterOptions {
  /** Top band cells; text may contain tokens. */
  header?: HeaderFooterBand;
  /** Bottom band cells; text may contain tokens. */
  footer?: HeaderFooterBand;
  /** 1-based pages, or a range string like '1-5,8'. Default: every page. */
  pages?: number[] | string;
  /** Inset in points from the page edges. Default 36. */
  margin?: number;
  /** Standard-14 face or an AddFont handle. Default 'Helvetica'. */
  font?: AuthoringFont;
  /** Text size in points. Default 10. */
  fontSize?: number;
  /** Fill color, components in 0..1. Default [0, 0, 0]. */
  color?: [number, number, number];
  /** Constant opacity 0..1. Default 1. */
  opacity?: number;
  /** Rule below the baseline of the stamped text. Default: none. */
  underline?: Decoration;
  /** Rule through the stamped text. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind the stamped text. Default: none. */
  background?: Background;
}

/** @internal Implementation of {@link Document.AddHeaderFooter}. */
export function addHeaderFooter(doc: Document, opts: HeaderFooterOptions): void {
  const slots: Array<{ text: string; position: StampPosition }> = [];
  const bands = [['header', 'top'], ['footer', 'bottom']] as const;
  for (const [key, band] of bands) {
    const cells = opts[key];
    if (cells === undefined) continue;
    for (const side of ['left', 'center', 'right'] as const) {
      const text = cells[side];
      if (typeof text !== 'string' || text === '') continue;
      slots.push({ text, position: `${band}-${side}` as StampPosition });
    }
  }
  if (slots.length === 0) return;

  // Validate every slot before drawing any of them, so a typo in the last slot
  // cannot leave the first already stamped.
  for (const s of slots) validateTemplate(s.text, false);

  const base = normalizePlacement({
    position: slots[0].position, // per-slot below; validated once here
    margin: opts.margin ?? 36,
    opacity: opts.opacity ?? 1,
    font: opts.font ?? 'Helvetica',
    fontSize: opts.fontSize ?? 10,
    color: opts.color ?? [0, 0, 0],
    underlay: false,
    underline: opts.underline,
    strikethrough: opts.strikethrough,
    background: opts.background,
  });

  const pagesArr = doc.Pages;
  const selected = resolvePages(opts.pages, pagesArr.length);
  const now = stampedNow();
  const needsLabel = slots.some((s) => usesLabel(s.text));

  for (const n of selected) {
    const values = tokenValuesFor(doc, n, pagesArr.length, now, needsLabel);
    for (const s of slots) {
      drawText(doc, pagesArr[n - 1], resolveTemplate(s.text, values),
        { ...base, position: s.position });
    }
  }
}

/** Options for {@link Document.AddBatesNumbering}. */
export interface BatesOptions {
  /** Template; `{bates}` is the counter. Default '{bates}'. */
  text?: string;
  /** 1-based pages, or a range string like '1-5,8'. Default: every page. */
  pages?: number[] | string;
  /** First number. Default 1. */
  start?: number;
  /** Increment per stamped page. Default 1. */
  step?: number;
  /** Minimum zero-padded width; a longer number simply widens. Default 6. */
  digits?: number;
  /** Text before the number. Default ''. */
  prefix?: string;
  /** Text after the number. Default ''. */
  suffix?: string;
  /** Positioning preset. Default 'bottom-right'. */
  position?: StampPosition;
  /** Inset in points from the page edges. Default 36. */
  margin?: number;
  /** Standard-14 face or an AddFont handle. Default 'Helvetica'. */
  font?: AuthoringFont;
  /** Text size in points. Default 10. */
  fontSize?: number;
  /** Fill color, components in 0..1. Default [0, 0, 0]. */
  color?: [number, number, number];
  /** Constant opacity 0..1. Default 1. */
  opacity?: number;
  /** Rule below the baseline of the stamped text. Default: none. */
  underline?: Decoration;
  /** Rule through the stamped text. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind the stamped text. Default: none. */
  background?: Background;
}

/** @internal Implementation of {@link Document.AddBatesNumbering}. Returns the
 *  next unused number so a sequence chains across a document set. */
export function addBatesNumbering(doc: Document, opts: BatesOptions = {}): number {
  const text = opts.text ?? '{bates}';
  validateTemplate(text, true);

  const start = opts.start ?? 1;
  const step = opts.step ?? 1;
  const digits = opts.digits ?? 6;
  if (!Number.isInteger(start) || start < 0)
    throw new TypeError('AddBatesNumbering: start must be a non-negative integer');
  if (!Number.isInteger(step) || step < 1)
    throw new TypeError('AddBatesNumbering: step must be a positive integer');
  if (!Number.isInteger(digits) || digits < 1)
    throw new TypeError('AddBatesNumbering: digits must be a positive integer');
  const prefix = opts.prefix ?? '';
  const suffix = opts.suffix ?? '';

  const p = normalizePlacement({
    position: opts.position ?? 'bottom-right',
    margin: opts.margin ?? 36,
    opacity: opts.opacity ?? 1,
    font: opts.font ?? 'Helvetica',
    fontSize: opts.fontSize ?? 10,
    color: opts.color ?? [0, 0, 0],
    underlay: false,
    underline: opts.underline,
    strikethrough: opts.strikethrough,
    background: opts.background,
  });

  const pagesArr = doc.Pages;
  const selected = resolvePages(opts.pages, pagesArr.length);
  const now = stampedNow();
  const needsLabel = usesLabel(text);

  // The counter follows the selection, not the page number: stamping a subset
  // must not leave gaps in a legal-numbering sequence.
  selected.forEach((n, i) => {
    const counter = start + step * i;
    const values = tokenValuesFor(doc, n, pagesArr.length, now, needsLabel);
    // `digits` is a minimum width (padStart semantics), so overflow widens.
    values.bates = prefix + String(counter).padStart(digits, '0') + suffix;
    drawText(doc, pagesArr[n - 1], resolveTemplate(text, values), p);
  });

  return start + step * selected.length;
}
