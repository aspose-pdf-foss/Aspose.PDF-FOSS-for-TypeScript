import type { Page } from '../../src/index.js';
import type { AuthoringFont } from '../../src/stamp.js';

export const PRODUCT_NAME = 'Aspose.PDF FOSS for TypeScript';
export const DOC_TITLE = `${PRODUCT_NAME} — Feature Showcase`;
export const DOC_AUTHOR = 'Aspose';
export const DOC_VERSION = 'v0.0.0';

/** A rectangle in the Go example's shape: lower-left and upper-right corners.
 *  Kept so the ported numeric literals read exactly as they do in main.go. */
export type Box = [number, number, number, number];

export const NAVY: [number, number, number] = [0.15, 0.20, 0.55];
export const DEEP_NAVY: [number, number, number] = [0.10, 0.15, 0.40];
export const INK: [number, number, number] = [0.15, 0.16, 0.20];
export const MUTED: [number, number, number] = [0.4, 0.4, 0.45];
export const FAINT: [number, number, number] = [0.5, 0.5, 0.55];
export const WHITE: [number, number, number] = [1, 1, 1];
export const TINT: [number, number, number] = [0.95, 0.96, 1.0];
export const GREEN: [number, number, number] = [0.10, 0.55, 0.25];
export const BROWN: [number, number, number] = [0.6, 0.3, 0.1];

/** The library's rect shape: origin plus extent. */
export function xywh(b: Box): [number, number, number, number] {
  return [b[0], b[1], b[2] - b[0], b[3] - b[1]];
}

/** /QuadPoints for one rectangle, in the spec's corner order:
 *  top-left, top-right, bottom-left, bottom-right. */
export function rectToQuads(b: Box): number[] {
  const [llx, lly, urx, ury] = b;
  return [llx, ury, urx, ury, llx, lly, urx, lly];
}

/** A box of `w` x `h` centred inside `outer`. */
export function centeredRect(outer: Box, w: number, h: number): Box {
  const cx = (outer[0] + outer[2]) / 2;
  const cy = (outer[1] + outer[3]) / 2;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

export function pageWidth(page: Page): number {
  return page.Rect[2] - page.Rect[0];
}

export function pageHeight(page: Page): number {
  return page.Rect[3] - page.Rect[1];
}

/** The Go example's TextStyle, so ported call sites keep their shape.
 *  `lineSpacing` is a multiple of the font size (Go semantics); the library's
 *  `leading` is absolute points, and addText converts. */
export interface TextStyle {
  font?: AuthoringFont;
  size?: number;
  color?: [number, number, number];
  opacity?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  valign?: 'top' | 'center' | 'bottom';
  lineSpacing?: number;
  underline?: boolean;
  strikethrough?: boolean;
  background?: [number, number, number];
  rotate?: number;
  behind?: boolean;
}

/** Flow `text` into `box`, the adapter for Go's rect-plus-style AddText.
 *  Overflow is dropped, exactly as Go's AddText clips at the box boundary.
 *
 *  `lineSpacing` defaults to 1.0, not the library's 1.2. Go's AddText anchors a
 *  line inside its rect, so the ported call sites size their boxes to the text
 *  and set a looser spacing explicitly (1.3 / 1.4) where they want one. Keeping
 *  the library default here would make every single-line box ~20% too short and
 *  the line would be clipped away silently — which is exactly what happened to
 *  the cover's CTA labels the first time this ran. */
export function addText(page: Page, text: string, box: Box, style: TextStyle = {}): void {
  const size = style.size ?? 12;
  page.AddTextBlock(text, xywh(box), {
    font: style.font ?? 'Helvetica',
    fontSize: size,
    color: style.color,
    opacity: style.opacity,
    align: style.align,
    valign: style.valign,
    leading: (style.lineSpacing ?? 1) * size,
    underline: style.underline,
    strikethrough: style.strikethrough,
    background: style.background,
    rotate: style.rotate,
    behind: style.behind,
  });
}

/** A section's title and italic subtitle, in the shared body-page style. */
export function sectionHeader(page: Page, title: string, subtitle = ''): void {
  const w = pageWidth(page);
  const h = pageHeight(page);
  addText(page, title, [50, h - 90, w - 50, h - 55], {
    font: 'Helvetica-Bold', size: 26, color: NAVY, align: 'center',
  });
  if (subtitle) {
    addText(page, subtitle, [50, h - 113, w - 50, h - 98], {
      font: 'Helvetica-Oblique', size: 11, color: MUTED, align: 'center',
    });
  }
}

export interface CardGridOptions {
  cols: number;
  rows: number;
  /** Grid bounds in page space. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  gapX?: number;
  gapY?: number;
  /** Horizontal inset of the label and content from the card edge. Default 12. */
  labelInset?: number;
  /** Height of the label strip at the top of each card. Default 22. */
  labelHeight?: number;
  /** Label type size. Default 11. */
  labelSize?: number;
}

/** Draw a grid of labelled cards and return each card's inner content box.
 *
 *  The two passes are the point of this helper. `PageGraphics` buffers until
 *  `apply()` while `addText` appends to `/Contents` straight away, so every
 *  frame has to be committed before any label is drawn — otherwise the fills
 *  splice in last and paint over the labels. `apply()` is single-shot, so this
 *  cannot be done per card. Three sections depend on that ordering and it is
 *  invisible in the output when only one of them gets it wrong, which is why it
 *  lives here rather than at the call sites. */
export function cardGrid(page: Page, labels: string[], opts: CardGridOptions): Box[] {
  const gapX = opts.gapX ?? 14;
  const gapY = opts.gapY ?? 14;
  const labelInset = opts.labelInset ?? 12;
  const labelHeight = opts.labelHeight ?? 22;
  const labelSize = opts.labelSize ?? 11;
  const cardW = (opts.right - opts.left - gapX * (opts.cols - 1)) / opts.cols;
  const cardH = (opts.top - opts.bottom - gapY * (opts.rows - 1)) / opts.rows;

  // Pass 1 — every frame, committed in one apply().
  const frames = page.Graphics();
  const labelBoxes: Box[] = [];
  const inners: Box[] = [];
  labels.forEach((_, i) => {
    const col = i % opts.cols;
    const row = Math.floor(i / opts.cols);
    const x = opts.left + col * (cardW + gapX);
    const y = opts.top - (row + 1) * cardH - row * gapY;
    frames.setFillColor([0.985, 0.985, 0.995])
      .setStrokeColor([0.83, 0.85, 0.92]).setLineWidth(0.5)
      .roundedRect(x, y, cardW, cardH, 6).fillStroke();
    labelBoxes.push([
      x + labelInset, y + cardH - labelHeight - 2, x + cardW - labelInset, y + cardH - 4,
    ]);
    inners.push([
      x + labelInset, y + 10, x + cardW - labelInset, y + cardH - labelHeight - 6,
    ]);
  });
  frames.apply();

  // Pass 2 — labels, on top of committed frames.
  labels.forEach((label, i) => {
    addText(page, label, labelBoxes[i], {
      font: 'Helvetica-Bold', size: labelSize, color: NAVY,
    });
  });

  return inners;
}

/** A thin rule plus "<title>   ·   <index> / <total>" at the page foot. */
export function addUnifiedFooter(page: Page, index: number, total: number): void {
  const w = pageWidth(page);
  const g = page.Graphics();
  g.setStrokeColor([0.85, 0.85, 0.9]).setLineWidth(0.5)
    .drawLine(50, 40, w - 50, 40).stroke();
  g.apply();
  addText(page, `${DOC_TITLE}   ·   ${index} / ${total}`, [50, 22, w - 50, 36], {
    size: 8, color: [0.55, 0.55, 0.6], align: 'center',
  });
}
