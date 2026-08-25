import type { Document } from './document.js';
import type { Page } from './page.js';
import { enc, escapeName } from './serialize.js';
import {
  num, appendContent, ensureOwnResources,
  registerExtGStateIn, registerOcPropertyIn, registerShadingPatternIn,
  registerSoftMaskExtGStateIn, registerPatternRefIn,
} from './pagecontent.js';
import type { PdfDict } from './types.js';
import {
  validateGradient, normalizeStops, uniformOpacity, stopOpacity,
  axialShading, radialShading, shadingPattern, type Gradient, type ShadingVariant,
} from './gradient.js';
import { IDENTITY, invert, mul, type Matrix } from './text.js';
import {
  resolveTiling, tilingPatternDict,
  type TilingPattern, type TilingPatternOptions,
  type ColoredTilingPattern, type UncoloredTilingPattern,
} from './tiling.js';
import { UnsupportedFeatureError } from './errors.js';
import type { Layer } from './ocg.js';

function checkNum(label: string, n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new TypeError(`${label} must be a finite number`);
  return n;
}

function checkColor(rgb: [number, number, number]): [number, number, number] {
  if (!Array.isArray(rgb) || rgb.length !== 3 ||
      !rgb.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
  return rgb;
}

function checkEnum(label: string, v: number): number {
  if (v !== 0 && v !== 1 && v !== 2)
    throw new TypeError(`${label} must be 0, 1 or 2`);
  return v;
}

function checkAlpha(a: number): number {
  if (typeof a !== 'number' || !Number.isFinite(a) || a < 0 || a > 1)
    throw new TypeError('opacity must be in 0..1');
  return a;
}

/** k constant for a 4-bezier circle/ellipse approximation. */
const KAPPA = 0.5522847498307936;

/** Validate a polyline/polygon point list and return it. */
function checkPoints(points: [number, number][]): [number, number][] {
  if (!Array.isArray(points) || points.length < 2)
    throw new TypeError('points must be an array of at least 2 [x, y] pairs');
  for (const p of points)
    if (!Array.isArray(p) || p.length !== 2 ||
        !p.every((n) => typeof n === 'number' && Number.isFinite(n)))
      throw new TypeError('each entry of points must be an [x, y] pair of finite numbers');
  return points;
}

/** Which paint a gradient sets. Narrower than pagecontent's AlphaChannel:
 *  there is no 'both' paint. */
type PaintChannel = 'fill' | 'stroke';

/** A buffered builder for vector content: every path constructor, paint
 *  operator, graphics-state setting and marked-content bracket, accumulated in
 *  memory as operator text.
 *
 *  It is abstract because *where the operators go* and *where its resources are
 *  registered* are the two things a subclass supplies: {@link PageGraphics}
 *  answers with a page, and the tile builder behind
 *  `Document.NewTilingPattern` with a pattern's own dict.
 *
 *  Note what is deliberately NOT here: `apply()`. A tiling pattern's callback
 *  receives this type, so a tile builder cannot splice itself into a page —
 *  the method does not exist on what the callback holds, which makes the
 *  mistake unrepresentable rather than refused at runtime. */
export abstract class VectorGraphics {
  protected readonly parts: string[] = [];
  /** The CTM this builder's own operators have established. Tracked because a
   *  varying-alpha gradient's soft mask renders under the CTM in force where its
   *  `gs` runs, and must be given the inverse to stay in the default space its
   *  colour twin lives in. */
  private ctm: Matrix = [...IDENTITY];
  /** Which paint owns the soft mask currently in force, if any. See
   *  {@link claimSoftMask}. */
  private liveMask?: PaintChannel;
  /** What save() pushes and restore() pops: the two pieces of state above, which
   *  are the only coordinate- or state-sensitive things this builder knows. */
  private readonly stateStack: { ctm: Matrix; liveMask?: PaintChannel }[] = [];

  protected constructor(protected readonly doc: Document) {}

  /** The /Resources dict this builder's registrations land in. A page builder
   *  answers with the page's own resources; a tile builder with the pattern's,
   *  which is the whole reason this is a hook rather than a field. */
  protected abstract resources(): PdfDict;

  /** The box a luminosity soft mask covers, in the space this builder's
   *  /Matrix establishes. A page builder answers with its MediaBox; a tile
   *  builder with its own cell. */
  protected abstract maskBBox(): [number, number, number, number];

  private op(s: string): this {
    this.parts.push(s);
    return this;
  }

  // ---- graphics state ----
  setLineWidth(w: number): this { return this.op(`${num(checkNum('lineWidth', w))} w`); }
  setStrokeColor(rgb: [number, number, number]): this {
    const [r, g, b] = checkColor(rgb);
    return this.op(`${num(r)} ${num(g)} ${num(b)} RG`);
  }
  setFillColor(rgb: [number, number, number]): this {
    const [r, g, b] = checkColor(rgb);
    return this.op(`${num(r)} ${num(g)} ${num(b)} rg`);
  }

  /** Fill subsequent paths with an axial or radial gradient. Symmetric with
   *  {@link setFillColor}: this sets the fill paint, and the next `fill()` /
   *  `fillEvenOdd()` / `fillStroke()` uses it. See {@link gradientPaint} for the
   *  invariants both gradient setters share. */
  setFillGradient(g: Gradient): this { return this.gradientPaint(g, 'fill'); }

  /** Stroke subsequent paths with an axial or radial gradient. Symmetric with
   *  {@link setStrokeColor}: this sets the stroke paint, and the next `stroke()`
   *  / `fillStroke()` uses it. See {@link gradientPaint} for the invariants both
   *  gradient setters share.
   *
   *  The ramp is pinned to page space and not to the path, so a gradient
   *  stroke's colour at a point depends on where that point IS, not on how far
   *  along the outline it lies. A ramp that follows a path is a different
   *  feature and is not this one. */
  setStrokeGradient(g: Gradient): this { return this.gradientPaint(g, 'stroke'); }

  /** Fill subsequent paths with `pattern`, a tiling pattern from
   *  {@link Document.NewTilingPattern}. An uncolored pattern additionally takes
   *  the colour to paint it in.
   *
   *  **Invariant:** the lattice is pinned to the parent stream's DEFAULT user
   *  space and ignores the CTM (32000-1 §8.7.3.1) — the same rule
   *  {@link setFillGradient} documents. A `transform()` earlier in this builder
   *  moves the path and not the tiling; place the lattice with the pattern's
   *  own `x` / `y` / `rotation` instead. */
  setFillPattern(pattern: ColoredTilingPattern): this;
  setFillPattern(pattern: UncoloredTilingPattern, color: [number, number, number]): this;
  setFillPattern(pattern: TilingPattern, color?: [number, number, number]): this {
    return this.patternPaint(pattern, color, 'fill');
  }

  /** Stroke subsequent paths with `pattern`. Symmetric with
   *  {@link setFillPattern}; see it for the invariants both share. */
  setStrokePattern(pattern: ColoredTilingPattern): this;
  setStrokePattern(pattern: UncoloredTilingPattern, color: [number, number, number]): this;
  setStrokePattern(pattern: TilingPattern, color?: [number, number, number]): this {
    return this.patternPaint(pattern, color, 'stroke');
  }

  /** The shared body. The two differ only in operator case, so there is one
   *  implementation — the reason gradientPaint is shared too. */
  private patternPaint(
    pattern: TilingPattern, color: [number, number, number] | undefined, ch: PaintChannel,
  ): this {
    if (pattern === null || typeof pattern !== 'object' ||
        typeof (pattern as { ref?: unknown }).ref !== 'object')
      throw new TypeError('pattern must come from Document.NewTilingPattern');
    // The overloads make these unreachable from TypeScript; they are here for a
    // JavaScript caller, and because silently painting an uncolored pattern
    // black is worse than refusing.
    if (pattern.paintType === 2 && color === undefined)
      throw new TypeError('an uncolored tiling pattern needs a color');
    if (pattern.paintType === 1 && color !== undefined)
      throw new TypeError('a colored tiling pattern takes no color');

    const key = registerPatternRefIn(this.doc, this.resources(), pattern.ref);
    const esc = escapeName(key);
    if (pattern.paintType === 2) {
      const [r, g, b] = checkColor(color!);
      return ch === 'fill'
        ? this.op('/Pattern /DeviceRGB cs').op(`${num(r)} ${num(g)} ${num(b)} /${esc} scn`)
        : this.op('/Pattern /DeviceRGB CS').op(`${num(r)} ${num(g)} ${num(b)} /${esc} SCN`);
    }
    return ch === 'fill'
      ? this.op('/Pattern cs').op(`/${esc} scn`)
      : this.op('/Pattern CS').op(`/${esc} SCN`);
  }

  /** The shared body of {@link setFillGradient} and {@link setStrokeGradient}.
   *  The two differ in exactly three things — operator case, the degenerate
   *  solid, and which alpha channel a uniform stop opacity folds into — so there
   *  is one implementation and not two: this path carries three invariants a
   *  copy would have to re-derive, and a later fix to one would silently miss
   *  the other.
   *
   *  **Invariant:** gradient coordinates are in the page's DEFAULT user space
   *  and ignore the CTM. A pattern /Matrix maps pattern space to the default
   *  space of the parent content stream (PDF 32000-1 §8.7.3.1), not to the CTM
   *  in force when the pattern is selected — so a `transform()` earlier in this
   *  builder moves the path and not the ramp. The upside is that apply()'s q/Q
   *  wrapping and appendContent's stream nesting can never shift a gradient.
   *
   *  A gradient with fewer than two stops, a zero-length axis, or a zero radius
   *  collapses to a solid colour and allocates no pattern. A uniform stop
   *  opacity folds into an /ExtGState carrying THIS channel's alpha alone — `ca`
   *  for a fill, `CA` for a stroke — so it OVERRIDES an earlier
   *  {@link setOpacity} in that channel rather than multiplying with it, and
   *  leaves the other paint alone. Stops whose opacities DIFFER become a
   *  luminosity soft mask, also carried on an /ExtGState and overriding earlier
   *  opacity the same way; a mask has no channel split, so it dims both paints.
   *
   *  Like every other graphics-state setting, that mask stays in force until a
   *  {@link restore}; wrap the paint in {@link save}/{@link restore} if later
   *  drawing must be unmasked. */
  private gradientPaint(g: Gradient, ch: PaintChannel): this {
    validateGradient(g);

    // Degenerate cases collapse to a solid, matching svggradient.ts's rules.
    // Each paints ONE stop, so it takes that stop's own opacity: using the
    // gradient-wide alpha here would paint a varying ramp's degenerate case
    // fully opaque.
    const flat = g.kind === 'linear' ? g.x1 === g.x2 && g.y1 === g.y2 : !(g.r > 0);
    if (g.stops.length < 2 || flat) {
      const s = g.stops[g.stops.length - 1];
      const a = stopOpacity(s);
      if (a < 1) this.channelOpacity(a, ch);
      return ch === 'fill' ? this.setFillColor(s.color) : this.setStrokeColor(s.color);
    }

    const stops = normalizeStops(g.stops);
    const shade = (variant: ShadingVariant) =>
      g.kind === 'linear' ? axialShading(g, stops, variant) : radialShading(g, stops, variant);

    const key = registerShadingPatternIn(this.doc, this.resources(), shadingPattern(shade('color')));
    const alpha = uniformOpacity(stops);
    if (alpha === null) {
      this.claimSoftMask(ch);
      // A varying ramp cannot fold into a single ca/CA: its grayscale twin
      // becomes a luminosity soft mask, whose group is un-transformed back into
      // the default space the colour pattern lives in.
      const gs = registerSoftMaskExtGStateIn(
        this.doc, this.resources(), shadingPattern(shade('alpha')),
        this.inverseCtm(), this.maskBBox());
      this.op(`/${escapeName(gs)} gs`);
    } else if (alpha < 1) this.channelOpacity(alpha, ch);
    return ch === 'fill'
      ? this.op(`/Pattern cs /${escapeName(key)} scn`)
      : this.op(`/Pattern CS /${escapeName(key)} SCN`);
  }

  /** An /ExtGState alpha scoped to ONE paint channel. A gradient's own opacity
   *  must not fade the other paint of the same path, which is why this is not
   *  {@link setOpacity} — that one means both channels, and its callers rely on
   *  it. */
  private channelOpacity(alpha: number, ch: PaintChannel): void {
    const key = registerExtGStateIn(this.doc, this.resources(), alpha, ch);
    this.op(`/${escapeName(key)} gs`);
  }

  /** Claim the single /SMask slot for `ch`. An /ExtGState holds ONE soft mask
   *  and it masks fill and stroke alike, so a varying-alpha fill and a
   *  varying-alpha stroke cannot both be in force: the second silently replaces
   *  the first, and the paint then uses the wrong ramp for one of them. The fix
   *  is to paint in two operations, the split svgdraw.ts makes in resolvePaint.
   *
   *  Re-claiming for the SAME channel is legal — nothing was painted through the
   *  mask being replaced — and every paint operator releases the claim, so the
   *  correct sequence (set, paint, set, paint) passes through untouched. */
  private claimSoftMask(ch: PaintChannel): void {
    if (this.liveMask !== undefined && this.liveMask !== ch)
      throw new UnsupportedFeatureError(
        'a varying-alpha fill gradient and a varying-alpha stroke gradient cannot be ' +
        'in force at once: an /ExtGState holds one soft mask, which masks both paints. ' +
        'Paint the fill and the stroke as two operations.');
    this.liveMask = ch;
  }

  /** The matrix that undoes this builder's current CTM — the soft-mask group's
   *  /Matrix. A singular CTM paints nothing at all, so identity is as good an
   *  answer as any and beats throwing from a fill. */
  private inverseCtm(): Matrix {
    try {
      // invert() hands back -0 for the off-diagonal of an axis-aligned CTM;
      // fold it to 0 so the emitted /Matrix reads as one.
      return invert(this.ctm).map((v) => (v === 0 ? 0 : v)) as Matrix;
    } catch {
      return [...IDENTITY];
    }
  }
  setLineCap(cap: 0 | 1 | 2): this { return this.op(`${checkEnum('lineCap', cap)} J`); }
  setLineJoin(join: 0 | 1 | 2): this { return this.op(`${checkEnum('lineJoin', join)} j`); }
  /** Miter limit: the ratio at which a miter join (`setLineJoin(0)`) is cut off
   *  into a bevel. The viewer default is 10, which spikes a sharp corner; lower
   *  it to clamp. Must be at least 1 (PDF 32000-1 8.4.3.5). */
  setMiterLimit(limit: number): this {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)
      throw new TypeError('miterLimit must be a finite number >= 1');
    return this.op(`${num(limit)} M`);
  }
  setDash(pattern: number[], phase = 0): this {
    if (!Array.isArray(pattern) || !pattern.every((n) => Number.isFinite(n) && n >= 0))
      throw new TypeError('dash pattern must be an array of non-negative finite numbers');
    checkNum('dash phase', phase);
    return this.op(`[${pattern.map(num).join(' ')}] ${num(phase)} d`);
  }
  setOpacity(alpha: number): this {
    const key = registerExtGStateIn(this.doc, this.resources(), checkAlpha(alpha));
    return this.op(`/${key} gs`);
  }

  // ---- nesting & transform ----
  save(): this {
    this.stateStack.push({ ctm: [...this.ctm], liveMask: this.liveMask });
    return this.op('q');
  }
  restore(): this {
    // An unbalanced restore() is the caller's business; keeping the last state
    // is the least surprising thing to do with one.
    const s = this.stateStack.pop();
    if (s !== undefined) { this.ctm = s.ctm; this.liveMask = s.liveMask; }
    return this.op('Q');
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): this {
    [a, b, c, d, e, f].forEach((n, i) => checkNum(`transform[${i}]`, n));
    this.ctm = mul([a, b, c, d, e, f], this.ctm);
    return this.op(`${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} cm`);
  }

  // ---- marked content (tagged PDF) ----
  /** Begin a marked-content sequence carrying an /MCID. Pair with
   *  {@link EndMarkedContent}. Obtain `mcid` from `element.NextMcid(this.page)`. */
  BeginMarkedContent(tag: string, mcid: number): this {
    return this.op(`/${escapeName(tag)} <</MCID ${mcid}>> BDC`);
  }

  /** Begin an artifact sequence: `/Artifact BMC`, marking the following ops as
   *  content that belongs to no structure element. Pair with
   *  {@link EndMarkedContent}. In a tagged page every piece of content must be
   *  either tagged or an artifact, and decoration is the latter. */
  BeginArtifact(): this {
    return this.op('/Artifact BMC');
  }

  /** End the most recent marked-content sequence. */
  EndMarkedContent(): this {
    return this.op('EMC');
  }

  /** Begin an optional-content sequence: `/OC /<key> BDC`, tagging following ops
   *  into `layer`. Registers the OCG in the page's /Resources /Properties. Pair
   *  with {@link EndLayer}. */
  BeginLayer(layer: Layer): this {
    const key = registerOcPropertyIn(this.doc, this.resources(), layer.Ref);
    return this.op(`/OC /${escapeName(key)} BDC`);
  }

  /** End the most recent {@link BeginLayer} sequence. */
  EndLayer(): this {
    return this.op('EMC');
  }

  // ---- path construction ----
  /** Whether a current point exists — i.e. a path is under construction and not
   *  yet painted. Only {@link arc} reads it, to decide between starting a
   *  subpath and connecting to the one in progress; every path constructor sets
   *  it and {@link paint} clears it. */
  private hasCurrentPoint = false;

  moveTo(x: number, y: number): this {
    this.hasCurrentPoint = true;
    return this.op(`${num(checkNum('x', x))} ${num(checkNum('y', y))} m`);
  }
  lineTo(x: number, y: number): this {
    this.hasCurrentPoint = true;
    return this.op(`${num(checkNum('x', x))} ${num(checkNum('y', y))} l`);
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    [x1, y1, x2, y2, x3, y3].forEach((n, i) => checkNum(`curve[${i}]`, n));
    this.hasCurrentPoint = true;
    return this.op(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x3)} ${num(y3)} c`);
  }
  rect(x: number, y: number, w: number, h: number): this {
    [x, y, w, h].forEach((n, i) => checkNum(`rect[${i}]`, n));
    // `re` is defined as m/l/l/l/h (PDF 32000-1 8.5.2.1), so it leaves a current
    // point exactly as the expansion would.
    this.hasCurrentPoint = true;
    return this.op(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`);
  }
  close(): this { return this.op('h'); }

  // ---- convenience constructors ----
  drawLine(x1: number, y1: number, x2: number, y2: number): this {
    return this.moveTo(x1, y1).lineTo(x2, y2);
  }
  drawRect(x: number, y: number, w: number, h: number): this {
    return this.rect(x, y, w, h);
  }
  circle(cx: number, cy: number, r: number): this {
    return this.ellipse(cx, cy, r, r);
  }

  /** An open polyline through `points` (at least two `[x, y]` pairs): a moveTo
   *  followed by a lineTo each. Compose with `stroke()`/`fill()`/`fillStroke()`
   *  like any other path. */
  polyline(points: [number, number][]): this {
    const pts = checkPoints(points);
    this.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) this.lineTo(pts[i][0], pts[i][1]);
    return this;
  }

  /** A closed polygon through `points`: {@link polyline} plus a closing `h`, so
   *  a fill has a well-defined boundary and a stroke joins the last edge to the
   *  first rather than capping it. */
  polygon(points: [number, number][]): this {
    return this.polyline(points).close();
  }

  /** A rectangle with quarter-circle corners of radius `r`, clamped to half the
   *  shorter side (so an over-large radius gives a stadium, never a self-crossing
   *  path). `r <= 0` emits a plain `re`, which is what the shape degenerates to
   *  and is one operator instead of nine. */
  roundedRect(x: number, y: number, w: number, h: number, r: number): this {
    [x, y].forEach((n, i) => checkNum(`roundedRect[${i}]`, n));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
      throw new TypeError('roundedRect width and height must be positive finite numbers');
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0)
      throw new TypeError('roundedRect radius must be a non-negative finite number');
    const rr = Math.min(r, w / 2, h / 2);
    if (rr === 0) return this.rect(x, y, w, h);

    const k = KAPPA * rr;
    const x1 = x + w, y1 = y + h;
    return this
      .moveTo(x + rr, y)
      .lineTo(x1 - rr, y)
      .curveTo(x1 - rr + k, y, x1, y + rr - k, x1, y + rr)          // bottom-right
      .lineTo(x1, y1 - rr)
      .curveTo(x1, y1 - rr + k, x1 - rr + k, y1, x1 - rr, y1)       // top-right
      .lineTo(x + rr, y1)
      .curveTo(x + rr - k, y1, x, y1 - rr + k, x, y1 - rr)          // top-left
      .lineTo(x, y + rr)
      .curveTo(x, y + rr - k, x + rr - k, y, x + rr, y)             // bottom-left
      .close();
  }

  /** A circular arc of radius `r` about (`cx`, `cy`), from `startAngle` to
   *  `endAngle` in **radians** (0 = +x axis, increasing counter-clockwise, as in
   *  Canvas 2D). `endAngle < startAngle` sweeps clockwise.
   *
   *  With a path already under construction the arc is joined to it by a line to
   *  its start point; otherwise it opens a new subpath there. Sweeps wider than
   *  90 degrees are split into that many cubic segments, since a single cubic
   *  cannot hold a wider arc to acceptable error. */
  arc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): this {
    checkNum('arc cx', cx);
    checkNum('arc cy', cy);
    checkNum('arc startAngle', startAngle);
    checkNum('arc endAngle', endAngle);
    if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0)
      throw new TypeError('arc radius must be a positive finite number');

    const at = (a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [sx, sy] = at(startAngle);
    if (this.hasCurrentPoint) this.lineTo(sx, sy);
    else this.moveTo(sx, sy);

    const sweep = endAngle - startAngle;
    const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const step = sweep / segments;
    // Control-point length for a cubic spanning `step`: the general form of the
    // KAPPA constant above, which is this at step = PI/2.
    const k = (4 / 3) * Math.tan(step / 4) * r;
    for (let i = 0; i < segments; i++) {
      const a0 = startAngle + i * step, a1 = a0 + step;
      const [p0x, p0y] = at(a0), [p3x, p3y] = at(a1);
      this.curveTo(
        p0x - k * Math.sin(a0), p0y + k * Math.cos(a0),
        p3x + k * Math.sin(a1), p3y - k * Math.cos(a1),
        p3x, p3y);
    }
    return this;
  }
  ellipse(cx: number, cy: number, rx: number, ry: number): this {
    [cx, cy, rx, ry].forEach((n, i) => checkNum(`ellipse[${i}]`, n));
    const ox = rx * KAPPA, oy = ry * KAPPA;
    return this
      .moveTo(cx + rx, cy)
      .curveTo(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry)
      .curveTo(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy)
      .curveTo(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry)
      .curveTo(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy)
      .close();
  }

  // ---- paint ----
  stroke(): this { return this.paint('S'); }
  fill(): this { return this.paint('f'); }
  fillEvenOdd(): this { return this.paint('f*'); }
  fillStroke(): this { return this.paint('B'); }

  /** A paint operator. Clears the soft-mask claim: the mask has done its job, so
   *  the other channel may take the single /SMask slot now. Also ends the path,
   *  so the next {@link arc} starts a fresh subpath instead of connecting to the
   *  one just painted. */
  private paint(op: string): this {
    this.liveMask = undefined;
    this.hasCurrentPoint = false;
    return this.op(op);
  }

}

/** A buffered builder for drawing vector content onto a page. Operators are
 *  accumulated in memory and spliced into the page's /Contents on apply(). */
export class PageGraphics extends VectorGraphics {
  /** Belongs to apply() alone, which is why it is not on the base: a tile
   *  builder has nothing to commit to. */
  private applied = false;

  constructor(doc: Document, readonly page: Page) {
    super(doc);
  }

  protected resources(): PdfDict {
    return ensureOwnResources(this.doc, this.page);
  }

  protected maskBBox(): [number, number, number, number] {
    const [a, b, c, d] = this.page.MediaBox;
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  }

  // ---- commit ----
  apply(): void {
    if (this.applied || this.parts.length === 0) return;
    const body = enc('q\n' + this.parts.join('\n') + '\nQ');
    appendContent(this.doc, this.page, body);
    this.parts.length = 0;
    this.applied = true;
  }
}

/** The builder a tiling pattern's callback draws into. Its registrations land
 *  in the pattern's own /Resources, and it has no apply(): a tile is committed
 *  by {@link buildTilingPattern}, never by the callback. @internal */
class TileGraphics extends VectorGraphics {
  /** The pattern's own /Resources, filled by whatever the callback registers. */
  readonly res: PdfDict = new Map();

  constructor(
    doc: Document,
    private readonly box: [number, number, number, number],
    private readonly uncolored: boolean,
  ) {
    super(doc);
  }

  protected resources(): PdfDict { return this.res; }
  protected maskBBox(): [number, number, number, number] { return this.box; }

  /** The buffered operators. No `q`/`Q` wrapper: a pattern cell is its own
   *  scope already, and PageGraphics.apply() wraps only because it splices into
   *  a stream that has other content in it. */
  ops(): string { return this.parts.join('\n'); }

  private refuseColor(what: string): never {
    throw new TypeError(
      `${what} is not allowed in an uncolored tiling pattern: a viewer ignores `
      + 'colour operators inside a PaintType 2 tile, and the colour is supplied '
      + 'where the pattern is used');
  }

  override setFillColor(rgb: [number, number, number]): this {
    if (this.uncolored) this.refuseColor('setFillColor');
    return super.setFillColor(rgb);
  }
  override setStrokeColor(rgb: [number, number, number]): this {
    if (this.uncolored) this.refuseColor('setStrokeColor');
    return super.setStrokeColor(rgb);
  }
  override setFillGradient(g: Gradient): this {
    if (this.uncolored) this.refuseColor('setFillGradient');
    return super.setFillGradient(g);
  }
  override setStrokeGradient(g: Gradient): this {
    if (this.uncolored) this.refuseColor('setStrokeGradient');
    return super.setStrokeGradient(g);
  }
}

/** Build a tiling pattern: validate, run `draw` into a tile-scoped builder, and
 *  allocate the pattern stream. Validation and the callback both run before the
 *  allocation, so a rejected call leaves the document byte-identical.
 *
 *  Behind `Document.NewTilingPattern`; see that method for the overloads that
 *  narrow the return type on `uncolored`. */
export function buildTilingPattern(
  doc: Document, width: number, height: number,
  draw: (g: VectorGraphics) => void, opts: TilingPatternOptions = {},
): TilingPattern {
  if (typeof draw !== 'function')
    throw new TypeError('draw must be a function');
  const r = resolveTiling(width, height, opts);
  const tile = new TileGraphics(doc, [0, 0, r.width, r.height], r.uncolored);
  draw(tile);
  const ops = tile.ops();
  // An empty tile has no defensible ink. Refusing beats allocating a pattern
  // that paints nothing wherever it is used.
  if (ops === '')
    throw new TypeError('a tiling pattern must draw something');
  const ref = doc.allocObject({
    kind: 'stream',
    dict: tilingPatternDict(r, tile.res),
    raw: enc(ops),
  });
  return { ref, paintType: r.uncolored ? 2 : 1 } as TilingPattern;
}
