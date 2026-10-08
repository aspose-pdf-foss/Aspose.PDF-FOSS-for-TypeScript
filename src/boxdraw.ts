// src/boxdraw.ts
/** The box painter (v9j3.4): one slice of a box (or a whole FloatingBox) to
 *  content. Geometry comes from boxpaint.ts; this module only emits, through
 *  PageGraphics, so gradients get its alpha soft-mask handling and patterns its
 *  resource registration.
 *
 *  **Invariant:** CSS paint order — clip to the rounded border box; the colour;
 *  the image layer; the border ring. The background clip is the BORDER box
 *  (CSS's initial background-clip); the positioning area is the padding box
 *  (initial background-origin), which `LayerPaint.area` carries.
 *
 *  **Invariant:** the layer is laid out against the WHOLE box (`area`) and only
 *  clipped to this slice, which is what keeps an image or gradient continuous
 *  across a column break. */
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PageGraphics, type VectorGraphics } from './graphics.js';
import type { BuiltImage } from './imageembed.js';
import {
  roundedRect, innerRadii, edgeWedges, hasRadius, tileSize, tileOrigin, cornerAngle, linearLine,
  radialRadii, placeStops, fitStops, premultiplyTransparent, clipStopsAtZero, lenOf,
  type Radii, type Seg, type BgLayer, type RadialExtent, type StopSpec, type Len,
} from './boxpaint.js';
import type { Gradient } from './gradient.js';
import type { Matrix } from './text.js';

export interface EdgePaint { width: number; color: [number, number, number] }
export type GradientSpec =
  | { kind: 'linear'; angle?: number; to?: [-1 | 0 | 1, -1 | 0 | 1]; stops: StopSpec[] }
  | { kind: 'radial'; shape: 'circle' | 'ellipse'; extent: RadialExtent; at: [Len, Len]; stops: StopSpec[] };
export type LayerSource =
  | { kind: 'image'; built: BuiltImage; width: number; height: number }
  | { kind: 'gradient'; g: GradientSpec };
export interface LayerPaint { source: LayerSource; layer: BgLayer; area: { x: number; top: number; w: number; h: number } }
export interface BoxPaintSpec {
  x: number; y: number; w: number; h: number; radii: Radii;
  color?: [number, number, number];
  edges: { top?: EdgePaint; right?: EdgePaint; bottom?: EdgePaint; left?: EdgePaint };
  layer?: LayerPaint;
}

function path(g: VectorGraphics, segs: Seg[]): VectorGraphics {
  for (const s of segs) {
    if (s[0] === 'm') g.moveTo(s[1], s[2]);
    else if (s[0] === 'l') g.lineTo(s[1], s[2]);
    else if (s[0] === 'c') g.curveTo(s[1], s[2], s[3], s[4], s[5], s[6]);
    else g.close();
  }
  return g;
}

/** A gradient in TILE-local PDF space (origin the tile's bottom-left), and the
 *  pattern matrix an ellipse needs. */
function pdfGradient(spec: GradientSpec, tw: number, th: number, ox: number, oy: number):
  { g: Gradient; m?: Matrix } {
  if (spec.kind === 'linear') {
    const angle = spec.to ? cornerAngle(spec.to[0], spec.to[1], tw, th) : spec.angle ?? 180;
    const l = linearLine(angle, tw, th);                 // top-down, tile-local
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
    const f = fitStops(premultiplyTransparent(placeStops(spec.stops, len)));
    const at = (t: number) => [l.x1 + (l.x2 - l.x1) * t, l.y1 + (l.y2 - l.y1) * t] as const;
    const [ax, ay] = at(f.t0), [bx, by] = at(f.t1);
    return { g: { kind: 'linear', x1: ox + ax, y1: oy + th - ay, x2: ox + bx, y2: oy + th - by, stops: f.stops } };
  }
  const cx = lenOf(spec.at[0], tw), cy = lenOf(spec.at[1], th);
  const { rx, ry } = radialRadii(spec.shape, spec.extent, cx, cy, tw, th);
  // A degenerate ending shape — one radius 0 — is a vanishing ellipse
  // (CSS Images 3): every point but a line lies past its last stop, so the
  // box takes the last colour. As a pattern it needs no singular /Matrix.
  if (!(rx > 0) || !(ry > 0)) {
    const placed = placeStops(spec.stops, 1);
    const last = placed[placed.length - 1];
    if (last === undefined) return { g: { kind: 'linear', x1: ox, y1: oy, x2: ox + 1, y2: oy, stops: [] } };
    const solid = { color: last.color, opacity: last.alpha };
    return { g: { kind: 'linear', x1: ox, y1: oy, x2: ox + tw, y2: oy, stops: [{ offset: 0, ...solid }, { offset: 1, ...solid }] } };
  }
  // A radial ramp starts at the centre: what lies before it is cut there at
  // the colour the line holds at 0, so the PDF function runs over [0, t1] of
  // the CSS ray, and r is scaled to t1.
  const stops = clipStopsAtZero(placeStops(spec.stops, rx));
  const fr = fitStops(premultiplyTransparent(stops));
  const pcx = ox + cx, pcy = oy + th - cy;
  const r = rx * fr.t1;
  if (spec.shape === 'circle' || rx === ry) return { g: { kind: 'radial', cx: pcx, cy: pcy, r, stops: fr.stops } };
  const k = ry / rx;                                   // scale y about the centre
  return { g: { kind: 'radial', cx: 0, cy: 0, r, stops: fr.stops }, m: [1, 0, 0, k, pcx, pcy] };
}

export function paintBox(doc: Document, page: Page, s: BoxPaintSpec, artifact: boolean): void {
  const g = new PageGraphics(doc, page);
  if (artifact) g.BeginArtifact();
  const outer = roundedRect(s.x, s.y, s.w, s.h, s.radii);

  if (s.color !== undefined || s.layer !== undefined) {
    g.save();
    path(g, outer).clipPath();
    if (s.color !== undefined) g.setFillColor(s.color).rect(s.x, s.y, s.w, s.h).fill();
    if (s.layer !== undefined) paintLayer(doc, g, s.layer);
    g.restore();
  }

  const e = s.edges;
  const b = { top: e.top?.width ?? 0, right: e.right?.width ?? 0, bottom: e.bottom?.width ?? 0, left: e.left?.width ?? 0 };
  if (b.top + b.right + b.bottom + b.left > 0) {
    const inner = roundedRect(s.x + b.left, s.y + b.bottom, s.w - b.left - b.right, s.h - b.top - b.bottom,
      innerRadii(s.radii, b, s.w, s.h));
    const colors = (['top', 'right', 'bottom', 'left'] as const).filter((k) => b[k] > 0).map((k) => e[k]!.color.join(','));
    if (new Set(colors).size <= 1) {
      const c = (e.top ?? e.right ?? e.bottom ?? e.left)!.color;
      path(path(g, outer), inner).setFillColor(c).fillEvenOdd();
    } else {
      const w = edgeWedges(s.x, s.y, s.w, s.h, b, innerRadii(s.radii, b, s.w, s.h));
      for (const k of ['top', 'right', 'bottom', 'left'] as const) {
        if (!(b[k] > 0)) continue;
        g.save();
        g.polygon(w[k]).clipPath();
        path(path(g, outer), inner).setFillColor(e[k]!.color).fillEvenOdd();
        g.restore();
      }
    }
  }
  if (artifact) g.EndMarkedContent();
  g.apply();
}

function paintLayer(doc: Document, g: PageGraphics, lp: LayerPaint): void {
  const { area, layer, source } = lp;
  const natural = source.kind === 'image' ? { w: source.width, h: source.height } : undefined;
  const t = tileSize(layer.size, area.w, area.h, natural);
  if (!(t.w > 0) || !(t.h > 0)) return;
  const o = tileOrigin(layer, area.w, area.h, t.w, t.h);
  // Tile's bottom-left in PDF space.
  const tx = area.x + o.x, ty = area.top - o.y - t.h;

  const drawTile = (dst: VectorGraphics, x: number, y: number): void => {
    if (source.kind === 'image') { dst.placeImage(source.built, x, y, t.w, t.h); return; }
    const { g: grad, m } = pdfGradient(source.g, t.w, t.h, x, y);
    dst.save().rect(x, y, t.w, t.h).clipPath();
    if (m) dst.setFillGradientMatrix(grad, m); else dst.setFillGradient(grad);
    dst.rect(x, y, t.w, t.h).fill().restore();
  };

  if (!layer.repeatX && !layer.repeatY) { drawTile(g, tx, ty); return; }
  // One axis only: a band through the tile, clipped, then the pattern fills it.
  g.save();
  if (!layer.repeatX) g.rect(tx, area.top - area.h - 1e5, t.w, area.h + 2e5).clipPath();
  if (!layer.repeatY) g.rect(area.x - 1e5, ty, area.w + 2e5, t.h).clipPath();
  const pat = doc.NewTilingPattern(t.w, t.h, (tg) => drawTile(tg, 0, 0), { x: tx, y: ty });
  g.setFillPattern(pat).rect(area.x - 1e5, area.top - area.h - 1e5, area.w + 2e5, area.h + 2e5).fill();
  g.restore();
}
