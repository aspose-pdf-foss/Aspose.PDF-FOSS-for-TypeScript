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
import type { GradientStop } from './gradient.js';
import { paintBox, type GradientSpec, type LayerSource } from './boxdraw.js';
import { resolveRadii, hasRadius, type CornerSpec, type BgLayer, type Len } from './boxpaint.js';

/** One corner's radius: a number, or [rx, ry] for an elliptical corner. Points. */
export type FloatBoxCorner = number | [number, number];
/** A box's corner radii (v9j3.4): one for all four, or per corner. Points. */
export type FloatBoxRadius = number | {
  topLeft?: FloatBoxCorner; topRight?: FloatBoxCorner; bottomRight?: FloatBoxCorner; bottomLeft?: FloatBoxCorner;
};
/** A BOX-RELATIVE gradient (v9j3.4). Linear: `angle` in CSS degrees, where 0
 *  runs bottom to top and 180 (the default) top to bottom. Radial: `shape`
 *  (default ellipse), a CSS size keyword (default farthest-corner) and `at`,
 *  the centre as fractions of the box (default [0.5, 0.5]). Stops as
 *  {@link GradientStop}. It lowers through the same rule a CSS gradient does. */
export type BoxGradient =
  | { kind: 'linear'; angle?: number; stops: GradientStop[] }
  | { kind: 'radial'; shape?: 'circle' | 'ellipse';
      size?: 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner';
      at?: [number, number]; stops: GradientStop[] };
/** A background image (v9j3.4). `fit` is a preset of the CSS rule:
 *  'stretch' (default, as .NET) fills the box; 'cover' and 'contain' centre it;
 *  'tile' repeats it at its natural size; 'none' draws it once at the top-left. */
export interface FloatBoxBackgroundImage {
  data: Uint8Array;
  fit?: 'stretch' | 'cover' | 'contain' | 'tile' | 'none';
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
}

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
  /** Background fill colour (rgb 0..1), or a box-relative gradient
   *  (v9j3.4). Default none. */
  background?: [number, number, number] | BoxGradient;
  /** Rounded corners (v9j3.4), in points. Default square. */
  radius?: FloatBoxRadius;
  /** A background image (v9j3.4). One layer: exclusive with a gradient
   *  `background`. Default none. */
  backgroundImage?: FloatBoxBackgroundImage;
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
  /** @internal (v9j3.4) */ readonly radii?: CornerSpec[];
  /** @internal (v9j3.4) */ readonly layer?: { source: LayerSource; layer: BgLayer };
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
    // (v9j3.4) Everything validated and the image decoded BEFORE anything is
    // stored, so a rejected box has allocated nothing.
    const bg = options.background;
    const grad = bg !== undefined && !Array.isArray(bg) ? checkGradient(bg) : undefined;
    if (bg !== undefined && Array.isArray(bg)) this.background = checkColor(bg, 'background');
    if (options.radius !== undefined) {
      const r = checkRadius(options.radius);
      if (r.some((c) => c.x.abs > 0 && c.y.abs > 0)) this.radii = r;
    }
    if (options.backgroundImage !== undefined) {
      if (grad !== undefined)
        throw new TypeError('background gradient and backgroundImage are exclusive: one background layer');
      this.layer = imageLayer(options.backgroundImage);
    } else if (grad !== undefined) {
      this.layer = { source: { kind: 'gradient', g: grad }, layer: STRETCH };
    }
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
    const built = buildImageXObject(data, options.format, 0, this.doc.loadLimits);
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

    // (v9j3.4) A radius, a gradient or an image goes through the one painter;
    // without them the chrome below is today's, byte for byte.
    const radii = resolveRadii(this.radii ?? [], this.width, h);
    if (hasRadius(radii) || this.layer !== undefined) {
      const e = this.border && bw > 0 ? resolveBorderSides(this.border.sides) : undefined;
      const edge = (on: boolean | undefined) => (on && this.border ? { width: bw, color: this.border.color } : undefined);
      paintBox(this.doc, page, {
        x, y: topY - h, w: this.width, h, radii,
        ...(this.background !== undefined ? { color: this.background } : {}),
        edges: { top: edge(e?.top), right: edge(e?.right), bottom: edge(e?.bottom), left: edge(e?.left) },
        ...(this.layer !== undefined ? { layer: {
          ...this.layer, area: { x: x + bw, top: topY - bw, w: this.width - 2 * bw, h: h - 2 * bw },
        } } : {}),
      }, structParent !== undefined);
      this.paintItems(page, x, topY, heights, structParent);
      return h;
    }

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
    this.paintItems(page, x, topY, heights, structParent);
    return h;
  }

  /** The box's content, top-down inside the padding box. */
  private paintItems(page: Page, x: number, topY: number, heights: number[], structParent?: StructElement): void {
    const bw = this.borderWidth;
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
  }
}

const F = (frac: number): Len => ({ abs: 0, frac });
/** `fit: 'stretch'` — the CSS rule for "fill the box". */
const STRETCH: BgLayer = { size: [F(1), F(1)], posX: F(0), posY: F(0), repeatX: false, repeatY: false };
const FITS: Record<NonNullable<FloatBoxBackgroundImage['fit']>, BgLayer> = {
  stretch: STRETCH,
  cover: { size: 'cover', posX: F(0.5), posY: F(0.5), repeatX: false, repeatY: false },
  contain: { size: 'contain', posX: F(0.5), posY: F(0.5), repeatX: false, repeatY: false },
  tile: { size: ['auto', 'auto'], posX: F(0), posY: F(0), repeatX: true, repeatY: true },
  none: { size: ['auto', 'auto'], posX: F(0), posY: F(0), repeatX: false, repeatY: false },
};

function checkCorner(c: FloatBoxCorner | undefined, name: string): CornerSpec {
  const [rx, ry] = c === undefined ? [0, 0] : typeof c === 'number' ? [c, c] : Array.isArray(c) && c.length === 2 ? c : [Number.NaN, Number.NaN];
  for (const v of [rx, ry]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${name} must be a finite number or [rx, ry]`);
    if (v < 0) throw new RangeError(`${name} must be >= 0`);
  }
  return { x: { abs: rx, frac: 0 }, y: { abs: ry, frac: 0 } };
}

function checkRadius(r: FloatBoxRadius): CornerSpec[] {
  if (typeof r === 'number' || Array.isArray(r)) {
    const c = checkCorner(r as FloatBoxCorner, 'radius');
    return [c, c, c, c];
  }
  if (typeof r !== 'object' || r === null) throw new TypeError('radius must be a number or a per-corner object');
  return [checkCorner(r.topLeft, 'radius.topLeft'), checkCorner(r.topRight, 'radius.topRight'),
    checkCorner(r.bottomRight, 'radius.bottomRight'), checkCorner(r.bottomLeft, 'radius.bottomLeft')];
}

const SIZES = ['closest-side', 'closest-corner', 'farthest-side', 'farthest-corner'] as const;

/** (v9j3.7) The repo's validation split: TypeError for the wrong KIND of
 *  thing, RangeError for a value of the right kind outside its allowed set —
 *  checkCorner's rule, viewerprefs.ts's and formcreate.ts's. */
function keyword<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a string`);
  if (!(allowed as readonly string[]).includes(v)) throw new RangeError(`${what} must be one of ${allowed.join(', ')}`);
  return v as T;
}
function unit(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what} must be a finite number`);
  if (v < 0 || v > 1) throw new RangeError(`${what} must be in 0..1`);
  return v;
}

function checkGradient(g: BoxGradient): GradientSpec {
  if (typeof g !== 'object' || g === null) throw new TypeError('background gradient must be an object');
  keyword(g.kind, ['linear', 'radial'], 'background gradient kind');
  if (!Array.isArray(g.stops) || g.stops.length < 2) throw new TypeError('background gradient needs at least two stops');
  const stops = g.stops.map((st, i) => {
    if (typeof st !== 'object' || st === null) throw new TypeError(`gradient stop ${i} must be an object`);
    unit(st.offset, `gradient stop ${i}: offset`);
    const color = checkColor(st.color, `gradient stop ${i} color`);
    const alpha = unit(st.opacity ?? 1, `gradient stop ${i}: opacity`);
    return { color, alpha, pos: F(st.offset) };
  });
  if (g.kind === 'linear') {
    const angle = g.angle ?? 180;
    if (!Number.isFinite(angle)) throw new TypeError('gradient angle must be a finite number');
    return { kind: 'linear', angle, stops };
  }
  const shape = keyword(g.shape ?? 'ellipse', ['circle', 'ellipse'], 'radial shape');
  const size = keyword(g.size ?? 'farthest-corner', SIZES, 'radial size');
  const at = g.at ?? [0.5, 0.5];
  if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => Number.isFinite(v)))
    throw new TypeError('radial at must be [x, y] fractions of the box');
  return { kind: 'radial', shape, extent: size, at: [F(at[0]), F(at[1])], stops };
}

function imageLayer(im: FloatBoxBackgroundImage): { source: LayerSource; layer: BgLayer } {
  if (typeof im !== 'object' || im === null || !(im.data instanceof Uint8Array))
    throw new TypeError('backgroundImage.data must be a Uint8Array');
  // An array, not `in FITS`: a fit named `constructor` must not find Object.prototype's.
  const fit = keyword(im.fit ?? 'stretch', ['stretch', 'cover', 'contain', 'tile', 'none'] as const, 'backgroundImage.fit');
  const built = buildImageXObject(im.data, im.format);
  const w = built.stream.dict.get('Width'), h = built.stream.dict.get('Height');
  if (typeof w !== 'number' || typeof h !== 'number') throw new TypeError('backgroundImage has no size');
  // Natural size: pixels x 0.75pt, the rule an <img> already uses.
  return { source: { kind: 'image', built, width: w * 0.75, height: h * 0.75 }, layer: FITS[fit] };
}
