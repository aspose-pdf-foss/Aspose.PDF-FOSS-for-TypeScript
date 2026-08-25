import type { Document } from './document.js';
import type { Page } from './page.js';
import { layoutText, winAnsiDriver, type FontDriver } from './layout.js';
import { EmbeddedFont } from './embeddedfont.js';
import { buildImageXObject, drawBuiltImage, type BuiltImage } from './imageembed.js';
import { PageGraphics } from './graphics.js';
import {
  checkBorderSides, countBorderEdges, resolveBorderSides, type BorderSides,
} from './bordersides.js';
import { stampTextBlock, type TextBlockOptions, type AuthoringFont } from './stamp.js';
import type { StructElement } from './struct.js';
import type { FlowParagraphOptions } from './flow.js';

/** Options for {@link Document.NewFloatingBox}. All lengths are in points. */
export interface FloatBoxOptions {
  /** Outer (border-box) width in points. Required, > 0. */
  width: number;
  /** Inside padding between border and content. Default 0. */
  padding?: number | { top: number; right: number; bottom: number; left: number };
  /** Border stroke, optionally on a subset of the edges (`{ left: true }` is a
   *  pull-quote rule). Default none, and default `'all'` edges. The `sides`
   *  vocabulary is the one the table `BorderInfo` uses — both are "a rectangle
   *  with a subset of its edges drawn". */
  border?: { width: number; color: [number, number, number]; sides?: BorderSides };
  /** Background fill color (rgb 0..1). Default none. */
  background?: [number, number, number];
  /** Gap between consecutive box elements, the horizontal band the wrapped text
   *  keeps from the box (`band = width + spacing`), and the vertical gap above/
   *  below the box. One knob, three uses. Default 0. */
  spacing?: number;
  /** Alt text for the box's `/Figure` when the flow is tagged. */
  alt?: string;
}

/** Options for {@link FloatingBox.AddImage}. */
export interface FloatBoxImageOptions {
  /** Drawn width, points. Default: the box content width. */
  width?: number;
  /** Drawn height, points. Omitted/0 → auto from aspect ratio at the drawn width. */
  height?: number;
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
}

type Padding = { top: number; right: number; bottom: number; left: number };

interface ParaItem { kind: 'paragraph'; text: string; opts: FlowParagraphOptions; }
interface ImageItem { kind: 'image'; built: BuiltImage; drawW: number; drawH: number; }
type BoxItem = ParaItem | ImageItem;

function checkNonNeg(v: number, name: string): number {
  if (!Number.isFinite(v) || v < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return v;
}
function checkColor(c: [number, number, number], name: string): [number, number, number] {
  if (!Array.isArray(c) || c.length !== 3 || !c.every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
    throw new TypeError(`${name} must be [r, g, b] with each component in 0..1`);
  return c;
}

/** A measuring {@link FontDriver}: wraps/measures like the font but emits no
 *  glyphs (measurement ignores `encode`), matching tableauthor.ts. */
function measuringDriver(font: AuthoringFont): FontDriver {
  const real: FontDriver = font instanceof EmbeddedFont ? font.driver() : winAnsiDriver(font);
  return { measure: (t, fs) => real.measure(t, fs), probe: (t) => real.probe(t), encode: () => new Uint8Array(0) };
}

/** A padded/bordered/filled box of paragraphs and/or an image, floated into a
 *  {@link Flow} column by `flow.AddFloatBox`. Create via `doc.NewFloatingBox`. */
export class FloatingBox {
  readonly width: number;
  readonly spacing: number;
  /** @internal */ readonly padding: Padding;
  /** @internal */ readonly borderWidth: number;
  /** @internal */ readonly border?: { width: number; color: [number, number, number]; sides?: BorderSides };
  /** @internal */ readonly background?: [number, number, number];
  /** @internal */ readonly alt?: string;
  private readonly items: BoxItem[] = [];

  constructor(private readonly doc: Document, options: FloatBoxOptions) {
    if (!Number.isFinite(options.width) || options.width <= 0)
      throw new TypeError('width must be a positive finite number');
    this.width = options.width;
    this.spacing = checkNonNeg(options.spacing ?? 0, 'spacing');
    const p = options.padding ?? 0;
    this.padding = typeof p === 'number'
      ? { top: checkNonNeg(p, 'padding'), right: checkNonNeg(p, 'padding'), bottom: checkNonNeg(p, 'padding'), left: checkNonNeg(p, 'padding') }
      : { top: checkNonNeg(p.top, 'padding.top'), right: checkNonNeg(p.right, 'padding.right'), bottom: checkNonNeg(p.bottom, 'padding.bottom'), left: checkNonNeg(p.left, 'padding.left') };
    if (options.border) {
      checkBorderSides(options.border.sides);
      this.border = {
        width: checkNonNeg(options.border.width, 'border.width'),
        color: checkColor(options.border.color, 'border.color'),
        ...(options.border.sides === undefined ? {} : { sides: options.border.sides }),
      };
    }
    // Reserved on every side regardless of which edges are drawn, so toggling
    // `sides` changes only the ink and never reflows the text inside the box.
    this.borderWidth = this.border?.width ?? 0;
    if (options.background) this.background = checkColor(options.background, 'background');
    this.alt = options.alt;
    if (this.contentWidth() <= 0)
      throw new TypeError('floating box contentWidth must be positive (reduce padding/border or raise width)');
  }

  /** Content width: outer width minus horizontal padding and both borders. */
  contentWidth(): number {
    return this.width - this.padding.left - this.padding.right - 2 * this.borderWidth;
  }

  /** Append a word-wrapped paragraph inside the box. Chainable. */
  AddParagraph(text: string, options: FlowParagraphOptions = {}): this {
    this.items.push({ kind: 'paragraph', text, opts: options });
    return this;
  }

  /** Append an image inside the box. `height` omitted/0 → auto from aspect at the
   *  drawn width (default the box content width). Chainable. */
  AddImage(data: Uint8Array, options: FloatBoxImageOptions = {}): this {
    const built = buildImageXObject(data, options.format);
    const w = built.stream.dict.get('Width') as number;
    const h = built.stream.dict.get('Height') as number;
    const drawW = options.width ?? this.contentWidth();
    if (!Number.isFinite(drawW) || drawW <= 0) throw new TypeError('image width must be positive');
    const drawH = options.height && options.height > 0 ? options.height : drawW * (h / w);
    this.items.push({ kind: 'image', built, drawW, drawH });
    return this;
  }

  /** Per-item heights and their total (content only, no padding/border). @internal */
  layoutItems(): { heights: number[]; total: number } {
    const cw = this.contentWidth();
    const heights = this.items.map((it) => {
      if (it.kind === 'image') return it.drawH;
      const fontSize = it.opts.fontSize ?? 12;
      const leading = it.opts.leading ?? 1.2 * fontSize;
      const font = it.opts.font ?? 'Helvetica';
      const res = layoutText(it.text, measuringDriver(font), fontSize, cw, Infinity, leading);
      return Math.max(1, res.lines.length) * leading;
    });
    let total = heights.reduce((a, b) => a + b, 0);
    if (this.items.length > 1) total += (this.items.length - 1) * this.spacing;
    return { heights, total };
  }

  /** Total box height: content + inter-element spacing + padding + borders. */
  measure(): number {
    return this.layoutItems().total + this.padding.top + this.padding.bottom + 2 * this.borderWidth;
  }

  /** Paint the box with its top-left corner at `(x, topY)` (PDF user space, y up).
   *  When `structParent` is given (tagged flow), each image is appended as a
   *  `/Figure` (with `/Alt`) and each paragraph as a `/P`, in order. Returns the
   *  height consumed. */
  paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number {
    const { heights, total } = this.layoutItems();
    const h = total + this.padding.top + this.padding.bottom + 2 * this.borderWidth;
    const bw = this.borderWidth;

    // Chrome: background fill, then border stroke (inset by bw/2 so the stroke
    // stays within the outer box).
    const g = new PageGraphics(this.doc, page);
    if (this.background) g.setFillColor(this.background).rect(x, topY - h, this.width, h).fill();
    if (this.border && bw > 0) {
      // Every edge sits on the same half-width-inset rectangle the four-sided
      // stroke uses, so a partial border lines up with a full one exactly. All
      // four keep the single `re`, which is what makes an unset `sides`
      // byte-identical to a border written before the option existed.
      const n = countBorderEdges(this.border.sides);
      if (n > 0) {
        const x0 = x + bw / 2, x1 = x + this.width - bw / 2;
        const y0 = topY - h + bw / 2, y1 = topY - bw / 2;
        g.setLineWidth(bw).setStrokeColor(this.border.color);
        if (n === 4) {
          g.rect(x0, y0, this.width - bw, h - bw).stroke();
        } else {
          const e = resolveBorderSides(this.border.sides);
          if (e.top) g.drawLine(x0, y1, x1, y1);
          if (e.right) g.drawLine(x1, y0, x1, y1);
          if (e.bottom) g.drawLine(x0, y0, x1, y0);
          if (e.left) g.drawLine(x0, y0, x0, y1);
          g.stroke();
        }
      }
    }
    g.apply();

    // Inner content, top-down inside the padding box.
    const cx = x + this.padding.left + bw;
    const cw = this.contentWidth();
    let top = topY - this.padding.top - bw;
    this.items.forEach((it, i) => {
      if (i > 0) top -= this.spacing;
      const eh = heights[i];
      if (it.kind === 'image') {
        const fig = structParent
          ? structParent.Append('Figure', this.alt !== undefined ? { alt: this.alt } : undefined)
          : undefined;
        drawBuiltImage(this.doc, page, it.built, [cx, top - it.drawH, it.drawW, it.drawH],
          fig ? { tag: fig } : {});
      } else {
        const tag = structParent ? structParent.Append('P') : undefined;
        const opts: TextBlockOptions = {
          font: it.opts.font, fontSize: it.opts.fontSize, color: it.opts.color,
          align: it.opts.align, leading: it.opts.leading, ...(tag ? { tag } : {}),
        };
        stampTextBlock(this.doc, page, it.text, [cx, top - eh, cw, eh], opts);
      }
      top -= eh;
    });
    return h;
  }
}
