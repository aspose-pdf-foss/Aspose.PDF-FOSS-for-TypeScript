import type { Document } from './document.js';
import { runOperation, runOperationAsync, type OperationContext, type OperationSteps } from './operation.js';
import type { OperationControlOptions } from './checkpoint.js';
import type { Page } from './page.js';
import type { PagePath, PathSubpath } from './paths.js';
import { Matrix, mul, translate, invert, apply } from './text.js';
import { PdfDict, PdfObject, PdfStream, isStream } from './types.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace, deviceGray, rgbHex, Rgb, ColorConverter } from './colorspace.js';
import { parseFunction } from './pdffunction.js';
import { imageHref, type AssetWriter } from './imagehref.js';
import {
  interpret, baseMatrix, arrNums, RenderSink, Path, StrokeStyle, TextRunInfo, OffscreenUse,
  fillsText, strokesText,
} from './pagerender.js';
import { BlendMode } from './blend.js';
import { strokeOutlinePolys } from './strokegeom.js';
import { glyphDisplacement, glyphOrigin } from './font.js';
import { rethrowLimit } from './errors.js';

import { renderShadingPatch } from './raster.js';
import { boxCorners, bounds } from './tableorient.js';
import type { Rect } from './text.js';

export interface SvgAssets {
  write: AssetWriter;
  patchDpi: number;
}

export interface SvgOptions extends OperationControlOptions {
  /** Which page box defines the viewport. Default 'crop'. */
  box?: 'crop' | 'media';
  /** Composite annotation and form-field /AP appearances. Default true. */
  annotations?: boolean;
}

/** Format a number for SVG output: fixed to ≤4 dp, trailing zeros stripped. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(4);
  return s.replace(/\.?0+$/, '') || '0';
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;');
}

export function matrixAttr(m: Matrix): string {
  return `matrix(${m.map(fmt).join(' ')})`;
}

/** PDF /BM name → CSS mix-blend-mode keyword (CamelCase → lowercase-hyphenated). */
export function blendCss(mode: BlendMode): string {
  return mode.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Accumulates SVG body markup plus a <defs> section with unique ids. */
class SvgWriter {
  private body: string[] = [];
  private defs: string[] = [];
  private idSeq = 0;
  constructor(private prefix = '') {}
  /** Redirect stack: while non-empty, emitted body markup is captured rather
   *  than written, so it can become a <mask>/<pattern>/<g> definition. */
  private redirect: string[][] = [];
  nextId(prefix: string): string { return `${this.prefix}${prefix}${this.idSeq++}`; }
  emit(s: string): void {
    const top = this.redirect[this.redirect.length - 1];
    if (top) top.push(s); else this.body.push(s);
  }
  addDef(s: string): void { this.defs.push(s); }
  beginCapture(): void { this.redirect.push([]); }
  endCapture(): string { const b = this.redirect.pop(); return b ? b.join('') : ''; }
  finish(width: number, height: number): string {
    const defs = this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" `
      + `viewBox="0 0 ${fmt(width)} ${fmt(height)}">${defs}${this.body.join('')}</svg>`;
  }
}

function num(doc: Document, o: PdfObject | undefined): number { const v = doc.resolve(o); return typeof v === 'number' ? v : 0; }

/** Serialize a structured Path to an SVG `d` string (absolute M/L/C/Z), with
 *  every point mapped through `m` into device space. Painted leaves bake the CTM
 *  into `d` and carry no `transform`, so their user space is the identity: this
 *  is what lets `clip-path` (which resolves in the referencing element's user
 *  space) intersect at the correct device position. A leaf that instead carried
 *  `transform=CTM` would re-apply that CTM to the already-device-space clip
 *  geometry, mirroring/scaling the clip — the defect behind aspose-…-cul. */
function pathToD(path: Path, m: Matrix = [1, 0, 0, 1, 0, 0]): string {
  let d = '';
  for (const s of path) {
    if (s.op === 'M') { const [x, y] = apply(m, s.x, s.y); d += `M${fmt(x)} ${fmt(y)}`; }
    else if (s.op === 'L') { const [x, y] = apply(m, s.x, s.y); d += `L${fmt(x)} ${fmt(y)}`; }
    else if (s.op === 'C') {
      const [x1, y1] = apply(m, s.x1, s.y1);
      const [x2, y2] = apply(m, s.x2, s.y2);
      const [x, y] = apply(m, s.x, s.y);
      d += `C${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x)} ${fmt(y)}`;
    } else d += 'Z';
  }
  return d;
}

function snapshotOutline(subpaths: readonly PathSubpath[]): Path {
  const outline: Path = [];
  for (const { segments, closed } of subpaths) {
    for (const segment of segments) {
      const [x, y] = segment.pt;
      if (segment.op === 'cubic') {
        const [x1, y1] = segment.c1;
        const [x2, y2] = segment.c2;
        outline.push({ op: 'C', x1, y1, x2, y2, x, y });
      } else {
        outline.push({ op: segment.op === 'move' ? 'M' : 'L', x, y });
      }
    }
    if (closed && segments.length) outline.push({ op: 'Z' });
  }
  return outline;
}

/** Export the recorded geometry and paint in caller-supplied order. @internal */
export function renderPathsToSvg(page: Page, paths: readonly PagePath[]): string {
  const { matrix, width, height } = baseMatrix(page, 'crop');
  const writer = new SvgWriter();
  for (const { subpaths, ctm, fill, stroke, fillRule, lineWidth } of paths) {
    if (!fill && !stroke) continue;
    const d = pathToD(snapshotOutline(subpaths), mul(ctm, matrix));
    if (!d) continue;
    const attrs = [`d="${d}"`, `fill="${fill ? rgbHex(fill.rgb) : 'none'}"`];
    if (fill && fillRule === 'evenodd') attrs.push('fill-rule="evenodd"');
    if (stroke) {
      const hairline = lineWidth === 0;
      attrs.push(`stroke="${rgbHex(stroke.rgb)}"`, `stroke-width="${hairline ? '1' : fmt(lineWidth)}"`);
      if (hairline) attrs.push('vector-effect="non-scaling-stroke"');
    }
    writer.emit(`<path ${attrs.join(' ')}/>`);
  }
  return writer.finish(width, height);
}

/** Uniform device-space scale of an affine matrix, for mapping user-space
 *  lengths (stroke width, dash) when a stroke's geometry is baked to device
 *  space. Exact for the page flip and any uniform scale/rotation (the common
 *  cases); the geometric mean for an anisotropic CTM. */
function uniformScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/** One closed device-space polygon (flat [x,y,...]) as an SVG subpath. */
function polyToD(p: number[]): string {
  let d = `M${fmt(p[0])} ${fmt(p[1])}`;
  for (let i = 2; i < p.length; i += 2) d += `L${fmt(p[i])} ${fmt(p[i + 1])}`;
  return d + 'Z';
}

function intersectBounds(a: Rect, b: Rect): Rect {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

/** A Bézier lies inside its control hull. A conservative bound suffices for
 *  allocation because the emitted SVG clip still defines the visible shape. */
function clipBounds(path: Path, matrix: Matrix): Rect {
  const rect: Rect = [Infinity, Infinity, -Infinity, -Infinity];
  function include(x: number, y: number): void {
    const [u, v] = apply(matrix, x, y);
    rect[0] = Math.min(rect[0], u); rect[1] = Math.min(rect[1], v);
    rect[2] = Math.max(rect[2], u); rect[3] = Math.max(rect[3], v);
  }
  for (const seg of path) {
    if (seg.op === 'C') { include(seg.x1, seg.y1); include(seg.x2, seg.y2); }
    if (seg.op !== 'Z') include(seg.x, seg.y);
  }
  return rect;
}

/** RenderSink that emits a standalone SVG document. */
export class SvgSink implements RenderSink {
  private w: SvgWriter;
  private captureBounds: Rect[] = [];
  private clipAreas = new Map<string, Rect>();
  private groupDepth = 0;
  /** Depth of open wrapper <g>s, plus clip-stack depth, per `save()`. */
  private saveStack: { depth: number; clips: number }[] = [];
  /** Active clip ids, innermost last. Clips are attributes on the leaves they
   *  clip, never wrapper elements: clip-path establishes a stacking context,
   *  which would isolate a non-isolated group's inner blend from the page
   *  (7wg). Nesting is expressed by chaining the <clipPath> defs instead. */
  private clipStack: string[] = [];
  /** clipStack saved across a capture — see beginOffscreen. */
  private clipSaves: string[][] = [];
  private fillAlpha = 1;
  private strokeAlpha = 1;
  private blend: BlendMode = 'Normal';
  private maskOpen = false;
  constructor(private doc: Document, private assets?: SvgAssets, area?: Rect, idPrefix = '') {
    this.w = new SvgWriter(idPrefix);
    if (area) this.captureBounds.push(area);
  }

  setAlpha(fill: number, stroke: number): void { this.fillAlpha = fill; this.strokeAlpha = stroke; }
  setBlend(mode: BlendMode): void { this.blend = mode; }

  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    _opts?: { backdrop?: boolean; knockout?: boolean },
  ): void {
    this.w.beginCapture();
    if (this.assets) this.captureBounds.push(region ? [region.x0, region.y0, region.x1, region.y1] : this.captureBounds[this.captureBounds.length - 1]);
    // Contents are captured unclipped: the active clip applies to whatever
    // *uses* the resulting definition. A tiling cell in particular lives
    // outside the region it fills, so clipping it here would erase it. Mirrors
    // beginOffscreen in raster.ts, which resets to a fresh Paint for the same
    // reason.
    this.clipSaves.push(this.clipStack);
    this.clipStack = [];
  }

  endOffscreen(use: OffscreenUse): void {
    const inner = this.w.endCapture();
    if (this.assets) this.captureBounds.pop();
    this.clipStack = this.clipSaves.pop() ?? [];
    if (use.kind === 'softmask') {
      const id = this.w.nextId('mask');
      const type = use.luminosity ? 'luminance' : 'alpha';
      this.w.addDef(`<mask id="${id}" maskUnits="userSpaceOnUse" style="mask-type:${type}">${inner}</mask>`);
      this.clearSoftMask();
      this.w.emit(`<g mask="url(#${id})">`);
      this.groupDepth++;
      this.maskOpen = true;
      return;
    }
    if (use.kind === 'tile') {
      const id = this.w.nextId('tile');
      // The cell was walked with the full device CTM (paintTiling uses
      // initialState(cellCtm)), because the raster backend composites the tile
      // itself. Here `use.matrix` is re-applied as patternTransform, so without
      // this wrapper it lands twice and the geometry leaves the tile box —
      // patterns then render empty. Undo one application to put the captured
      // content back in pattern space, where x/y/width/height are measured.
      const unmap = `<g transform="${matrixAttr(invert(use.matrix))}">${inner}</g>`;
      this.w.addDef(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" `
        + `x="${fmt(use.bbox[0])}" y="${fmt(use.bbox[1])}" `
        + `width="${fmt(use.xstep)}" height="${fmt(use.ystep)}" `
        + `patternTransform="${matrixAttr(use.matrix)}">${unmap}</pattern>`);
      // paintTiling never calls fill() — like `sh`, the pattern paints the whole
      // clipped region, so emit the covering rect here. The tile geometry is in
      // pattern space and patternTransform maps it, so the rect itself is
      // untransformed device space.
      this.fillViewportRect(`url(#${id})`);
      return;
    }
    if (use.kind === 'group') {
      // `isolation` must be a style property, not a presentation attribute:
      // CSS Compositing defines no presentation attribute for it, so
      // `isolation="isolate"` is an unknown attribute and is dropped — measured
      // in Chrome 150 and resvg 2.6.2, both of which ignore that form and both
      // of which honour this one. Merge with mix-blend-mode rather than
      // emitting a second `style`, which would discard one of the two.
      //
      // Only isolated groups get it. A non-isolated group's inner blends must
      // reach the page backdrop, which a stacking context would cut off.
      const style: string[] = [];
      if (use.isolated) style.push('isolation:isolate');
      if (use.blend !== 'Normal') style.push(`mix-blend-mode:${blendCss(use.blend)}`);
      const attrs = [`opacity="${fmt(use.alpha)}"`];
      if (style.length) attrs.push(`style="${style.join(';')}"`);
      attrs.push(...this.clipAttrs());
      this.w.emit(`<g ${attrs.join(' ')}>${inner}</g>`);
    }
  }

  // SVG 1.1 has no expression for per-element knockout; documented limitation.
  beginKnockoutElement(): void { /* no-op */ }
  endKnockoutElement(): void { /* no-op */ }

  clearSoftMask(): void {
    if (this.maskOpen) { this.w.emit('</g>'); this.groupDepth--; this.maskOpen = false; }
  }

  /** Presentation attributes shared by every painted element. */
  private paintAttrs(kind: 'fill' | 'stroke'): string[] {
    const a: string[] = [];
    const o = kind === 'fill' ? this.fillAlpha : this.strokeAlpha;
    if (o < 1) a.push(`${kind}-opacity="${fmt(o)}"`);
    if (this.blend !== 'Normal') a.push(`style="mix-blend-mode:${blendCss(this.blend)}"`);
    return a;
  }

  finish(width: number, height: number): string { return this.w.finish(width, height); }

  save(): void { this.saveStack.push({ depth: this.groupDepth, clips: this.clipStack.length }); }
  restore(): void {
    const target = this.saveStack.pop() ?? { depth: 0, clips: 0 };
    while (this.groupDepth > target.depth) { this.w.emit('</g>'); this.groupDepth--; }
    if (this.clipStack.length > target.clips) this.clipStack.length = target.clips;
  }

  /** The innermost active clip, or undefined when nothing is clipped. */
  private currentClip(): string | undefined { return this.clipStack[this.clipStack.length - 1]; }

  /** `clip-path` for a painted leaf. Append last, after paintAttrs. Correct only
   *  for a leaf whose user space is the identity (device-baked geometry, no
   *  `transform`): the clip geometry is device-space, and clip-path resolves in
   *  the referencing element's user space, so a non-identity leaf would
   *  re-transform the clip. Image and text carry a transform — use emitClipped. */
  private clipAttrs(): string[] {
    const id = this.currentClip();
    return id ? [`clip-path="url(#${id})"`] : [];
  }

  /** Emit a leaf that must carry its own `transform` (image, text). Its user
   *  space is not the identity, so the clip cannot ride on it as an attribute —
   *  that would re-apply the transform to the device-space clip geometry. Wrap
   *  it in an identity `<g clip-path>` instead, which resolves the clip in device
   *  space. The wrapper is a stacking context, so a clipped image or glyph run
   *  whose blend must reach a non-isolated group's backdrop is isolated — rare
   *  enough to accept, and unlike fills/strokes which stay wrapper-free (7wg). */
  private emitClipped(markup: string): void {
    const id = this.currentClip();
    this.w.emit(id ? `<g clip-path="url(#${id})">${markup}</g>` : markup);
  }

  /** Define a clipPath chained onto the enclosing clip and make it current.
   *  SVG intersects a <clipPath> with its own clip-path, so the innermost id
   *  alone denotes the full active clip. */
  private pushClip(child: string, prefix: string, area?: Rect): void {
    const id = this.w.nextId(prefix);
    const parent = this.currentClip();
    const chain = parent ? ` clip-path="url(#${parent})"` : '';
    this.w.addDef(`<clipPath id="${id}"${chain}>${child}</clipPath>`);
    if (this.assets) {
      const outer = this.patchBounds();
      this.clipAreas.set(id, area ? intersectBounds(outer, area) : outer);
    }
    this.clipStack.push(id);
  }

  private patchBounds(): Rect {
    const clip = this.currentClip();
    return (clip && this.clipAreas.get(clip)) || this.captureBounds[this.captureBounds.length - 1];
  }

  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void {
    const d = pathToD(path);
    if (!d) return;
    const rule = evenOdd ? ' clip-rule="evenodd"' : '';
    this.pushClip(`<path d="${d}" transform="${matrixAttr(ctm)}"${rule}/>`, 'clip',
      this.assets ? clipBounds(path, ctm) : undefined);
  }

  clipToStroke(path: Path, ctm: Matrix, style: StrokeStyle): void {
    // SVG 1.1 §14.3.5: the `stroke` property does not contribute to a clipping
    // path — only the child's fill geometry does. Emitting the source path with
    // stroke-width would clip to a zero-area line and paint nothing, so outline
    // the stroke (joins, caps, dashes, flattened Béziers) and clip to that. The
    // polygons come back already in device space, hence no transform here; they
    // share a winding sign, so the default nonzero rule unions them.
    const polys = strokeOutlinePolys(path, ctm, style);
    if (!polys.length) return;
    const d = polys.map((p) => polyToD(p)).join('');
    let area: Rect | undefined;
    if (this.assets) {
      area = [Infinity, Infinity, -Infinity, -Infinity];
      for (const poly of polys) for (let i = 0; i < poly.length; i += 2) {
        area[0] = Math.min(area[0], poly[i]); area[1] = Math.min(area[1], poly[i + 1]);
        area[2] = Math.max(area[2], poly[i]); area[3] = Math.max(area[3], poly[i + 1]);
      }
    }
    this.pushClip(`<path d="${d}"/>`, 'sclip', area);
  }

  fill(path: Path, ctm: Matrix, color: Rgb, evenOdd: boolean): void {
    const d = pathToD(path, ctm);
    if (!d) return;
    const attrs = [`d="${d}"`, `fill="${rgbHex(color)}"`];
    if (evenOdd) attrs.push('fill-rule="evenodd"');
    attrs.push('stroke="none"');
    attrs.push(...this.paintAttrs('fill'));
    attrs.push(...this.clipAttrs());
    this.w.emit(`<path ${attrs.join(' ')}/>`);
  }

  stroke(path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle): void {
    const d = pathToD(path, ctm);
    if (!d) return;
    // Geometry is baked to device space, so the width and dash lengths — given
    // in user space — scale by the CTM here rather than via a transform attr.
    const s = uniformScale(ctm);
    const attrs = [`d="${d}"`, 'fill="none"',
      `stroke="${rgbHex(color)}"`, `stroke-width="${fmt(style.width * s)}"`];
    if (style.dash.length) {
      attrs.push(`stroke-dasharray="${style.dash.map((x) => fmt(x * s)).join(' ')}"`);
      if (style.dashPhase) attrs.push(`stroke-dashoffset="${fmt(style.dashPhase * s)}"`);
    }
    if (style.cap) attrs.push(`stroke-linecap="${style.cap === 1 ? 'round' : 'square'}"`);
    if (style.join) attrs.push(`stroke-linejoin="${style.join === 1 ? 'round' : 'bevel'}"`);
    attrs.push(...this.paintAttrs('stroke'));
    attrs.push(...this.clipAttrs());
    this.w.emit(`<path ${attrs.join(' ')}/>`);
  }

  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void {
    const href = this.imageHref(stream, fillColor);
    const transform = matrixAttr(mul([1, 0, 0, -1, 0, 1], ctm)); // unit-square with local Y-flip
    if (href) {
      const attrs = ['x="0"', 'y="0"', 'width="1"', 'height="1"', 'preserveAspectRatio="none"',
        `transform="${transform}"`, `href="${href}"`];
      attrs.push(...this.paintAttrs('fill'));
      this.emitClipped(`<image ${attrs.join(' ')}/>`);
    } else {
      const attrs = ['x="0"', 'y="0"', 'width="1"', 'height="1"',
        `transform="${transform}"`, 'fill="#cccccc"'];
      this.emitClipped(`<rect ${attrs.join(' ')}/>`);
    }
  }

  /** The placement and font attributes of a run's <text> element, without paint
   *  or clip — shared by drawing the run and by clipping to it, so the two can
   *  never disagree about where the glyphs are. */
  private textAttrs(info: TextRunInfo): string[] {
    const L = mul(mul(translate(0, info.rise), info.tm), info.ctm);
    const tf: Matrix = [L[0], L[1], -L[2], -L[3], L[4], L[5]];
    const attrs = [`transform="${matrixAttr(tf)}"`, `font-size="${fmt(info.fontSize)}"`, `font-family="${info.fontFamily}"`];
    if (info.bold) attrs.push('font-weight="bold"');
    if (info.italic) attrs.push('font-style="italic"');
    return attrs;
  }

  /**
   * A run's character content.
   *
   * Horizontally this is just the text: the viewer advances along the element's
   * own x axis, which is what the transform already points along. Vertically it
   * cannot — SVG 1.1 has no `/WMode`, and a plain `<text>` would lay a Japanese
   * column out as a horizontal row — so each glyph gets a `<tspan>` at its own
   * position, computed from the same displacement and position-vector rules the
   * rasterizer places outlines with.
   *
   * The element's local y runs *down* text space (see the flip in
   * {@link textAttrs}), so a text-space offset is negated on the way in.
   */
  private textContent(info: TextRunInfo): string {
    if (info.font.wmode !== 1) return escapeXml(info.decoded.text);
    const parts: string[] = [];
    let penX = 0, penY = 0;
    for (const g of info.font.decodeGlyphs(info.bytes)) {
      if (g.text) {
        const [ox, oy] = glyphOrigin(g, penX, penY, info.fontSize, info.hscale);
        parts.push(`<tspan x="${fmt(ox)}" y="${fmt(-oy)}">${escapeXml(g.text)}</tspan>`);
      }
      const [dx, dy] = glyphDisplacement(g, info.fontSize, info.charSp, info.wordSp, info.hscale);
      penX += dx; penY += dy;
    }
    return parts.join('');
  }

  glyphRun(info: TextRunInfo): void {
    const content = this.textContent(info);
    if (content.length === 0) return;
    const attrs = this.textAttrs(info);
    // SVG expresses the text rendering mode natively: `fill` and `stroke` are
    // ordinary presentation attributes on <text>, so mode 1 needs `fill="none"`
    // rather than a second element. A non-painting mode never arrives — the
    // interpreter gates it — so the two flags are never both false here.
    attrs.push(`fill="${fillsText(info.mode) ? rgbHex(info.color) : 'none'}"`);
    attrs.push(...this.paintAttrs('fill'));
    if (strokesText(info.mode)) {
      attrs.push(`stroke="${rgbHex(info.strokeColor)}"`);
      // The width is user-space: <text> carries the run's own transform, so the
      // value goes in unscaled and the transform applies it, exactly as it does
      // for a stroked path.
      attrs.push(`stroke-width="${fmt(info.strokeStyle.width)}"`);
    }
    this.emitClipped(`<text ${attrs.join(' ')}>${content}</text>`);
  }

  clipToGlyphs(infos: readonly TextRunInfo[]): boolean {
    // Several <text> children of one <clipPath> ARE a union, so the shape this
    // backend needs for a text clipping mode costs it nothing extra.
    const els = infos
      .map((info) => {
        const content = this.textContent(info);
        return content.length === 0
          ? ''
          : `<text ${this.textAttrs(info).join(' ')}>${content}</text>`;
      })
      .filter((e) => e.length > 0);
    if (els.length === 0) return false;
    // SVG 1.1 §14.3.5 admits <text> as clipPath content, so the clip is the same
    // element glyphRun would have drawn. It keeps its own transform: clipPath
    // content resolves in the referencing element's user space, and what
    // references this is the shading's covering rect, which is emitted in device
    // space (identity) — so the two agree.
    //
    // The shapes are the viewer's font, not the PDF's outlines: this backend
    // draws substitute faces (see glyphRun), so a gradient shows through
    // approximately-shaped glyphs. Closer than one flat colour, which is all
    // the alternative offers.
    this.pushClip(els.join(''), 'tclip');
    return true;
  }

  shading(shading: PdfDict | PdfStream, ctm: Matrix, pattern: boolean): void {
    // Native gradients need only the dictionary. Bundle patches also read
    // mesh vertex data and distinguish a pattern fill from the sh operator.
    const dict = isStream(shading) ? shading.dict : shading;
    const doc = this.doc;
    const r = (o: PdfObject | undefined) => doc.resolve(o);
    const infl = (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]);
    const type = num(doc, dict.get('ShadingType'));
    if (this.assets && (type === 1 || (type >= 4 && type <= 7))) {
      let area = this.patchBounds();
      const bbox = arrNums(doc, dict.get('BBox'));
      if (bbox.length === 4) {
        area = intersectBounds(area, bounds(boxCorners(bbox as Rect, ctm)));
      }
      const [x, y, right, bottom] = area;
      if (right <= x || bottom <= y) return;
      const png = renderShadingPatch(doc, shading, ctm, pattern, area, this.assets.patchDpi);
      const href = this.assets.write(png, 'png');
      const attrs = [`x="${fmt(x)}" y="${fmt(y)}" width="${fmt(right - x)}" height="${fmt(bottom - y)}"`,
        `preserveAspectRatio="none" href="${href}"`, ...this.clipAttrs()];
      if (this.fillAlpha < 1) attrs.push(`opacity="${fmt(this.fillAlpha)}"`);
      if (this.blend !== 'Normal') attrs.push(`style="mix-blend-mode:${blendCss(this.blend)}"`);
      this.w.emit(`<image ${attrs.join(' ')}/>`);
      return;
    }
    const csObj = dict.get('ColorSpace');
    const cs = csObj !== undefined ? resolveColorSpace(csObj, r, infl) : deviceGray();
    const coords = arrNums(doc, dict.get('Coords'));
    const fnObj = dict.get('Function');
    const fn = fnObj !== undefined ? parseFunction(fnObj, r, infl, doc.loadLimits) : (x: number[]) => x;
    const stops = this.sampleStops(fn, cs, 8);

    // The covering rect is device-space (identity) so its clip lands correctly;
    // the CTM that maps shading space to device rides on gradientTransform.
    const gt = ` gradientTransform="${matrixAttr(ctm)}"`;
    if (type === 2 && coords.length >= 4) {
      const id = this.w.nextId('grad');
      this.w.addDef(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse"${gt} `
        + `x1="${fmt(coords[0])}" y1="${fmt(coords[1])}" x2="${fmt(coords[2])}" y2="${fmt(coords[3])}">`
        + stops + `</linearGradient>`);
      this.fillViewportRect(`url(#${id})`);
    } else if (type === 3 && coords.length >= 6) {
      const id = this.w.nextId('grad');
      this.w.addDef(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse"${gt} `
        + `fx="${fmt(coords[0])}" fy="${fmt(coords[1])}" cx="${fmt(coords[3])}" cy="${fmt(coords[4])}" r="${fmt(coords[5])}">`
        + stops + `</radialGradient>`);
      this.fillViewportRect(`url(#${id})`);
    } else {
      this.fillViewportRect('#808080');
    }
  }

  private sampleStops(fn: (x: number[]) => number[], cs: ColorConverter, n: number): string {
    let s = '';
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      s += `<stop offset="${fmt(t)}" stop-color="${rgbHex(cs.toRgb(fn([t])))}"/>`;
    }
    return s;
  }

  /** A device-space rect large enough to cover the page, bounded by the active
   *  clip. Being identity (no transform), its clip resolves in device space. */
  private fillViewportRect(paint: string): void {
    const attrs = ['x="-100000"', 'y="-100000"', 'width="200000"', 'height="200000"',
      `fill="${paint}"`];
    attrs.push(...this.clipAttrs());
    this.w.emit(`<rect ${attrs.join(' ')}/>`);
  }

  private imageHref(stream: PdfStream, fill: Rgb): string | undefined {
    return imageHref(this.doc, stream, fill, this.assets?.write);
  }
}

/** Render one page to a standalone SVG string. Caller cancellation/errors escape. */
export function renderPageToSvg(doc: Document, page: Page, opts: SvgOptions = {}): string {
  return runOperation('ToSvg', opts, (context) => renderPageToSvgSteps(doc, page, opts, context));
}

export function renderPageToSvgAsync(doc: Document, page: Page, opts: SvgOptions = {}): Promise<string> {
  return runOperationAsync('ToSvg', opts, (context) => renderPageToSvgSteps(doc, page, opts, context));
}

/** @internal */
export function* renderPageToSvgSteps(
  doc: Document, page: Page, opts: SvgOptions, context: OperationContext, assets?: SvgAssets,
): OperationSteps<string> {
  const box = opts.box ?? 'crop';
  const { matrix, width, height } = baseMatrix(page, box);
  const sink = new SvgSink(doc, assets, [0, 0, width, height]);
  try {
    interpret(doc, page, matrix, sink, { annotations: opts.annotations });
  } catch (caught) { rethrowLimit(caught);
    // Degrade: whatever was emitted before the failure still renders.
  }
  yield context.progress('render', 1, 1, page.Number);
  const result = sink.finish(width, height);
  yield context.progress('assemble', 1, 1, page.Number);
  return result;
}
