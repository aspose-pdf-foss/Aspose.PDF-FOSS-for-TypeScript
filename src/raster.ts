import type { Document } from './document.js';
import { Page } from './page.js';
import { enc } from './serialize.js';
import { name } from './types.js';
import { Matrix, mul, apply, translate } from './text.js';
import { PdfDict, PdfStream, PdfObject, isStream, isDict, isArray, isName } from './types.js';
import { Rgb, ColorConverter, resolveColorSpace } from './colorspace.js';
import { parseFunction } from './pdffunction.js';
import { normalizeFont } from './metrics.js';
import { getStd14Sfnt } from './std14fonts.js';
import {
  interpret, baseMatrix, arrNums, RenderSink, Path, StrokeStyle, TextRunInfo,
  OffscreenUse, MAX_OFFSCREEN_DEPTH, MAX_TILE_BLITS,
} from './pagerender.js';
import { ImageInfo } from './image.js';
import {
  ImageRgba, decodeImageRgba, NO_RASTER_DECODER, resolveNum, localDeviceGray, isIndexedCs,
} from './imagergba.js';

// Re-exported so `redact.ts` and the tests keep the import path they have had
// since before the move -- the shape `redact.ts` already uses for resprune.ts.
export { decodeImageRgba, type ImageRgba } from './imagergba.js';
import { SfntFont } from './sfnt.js';
import { CffFont } from './cff.js';
import { gidForProgram, gidForCid, loadEmbeddedProgram } from './glyphprogram.js';
import { inflateStream } from './flate.js';
import { decodeJpeg, JpegImage } from './jpeg.js';
import { encodePng } from './pngencode.js';
import { BlendMode, blendPixel } from './blend.js';
import { Poly, flattenPath, ctmScale, strokeOutlinePolys } from './strokegeom.js';
import { glyphPolys } from './glyphoutline.js';
import {
  glyphDisplacement, glyphNameResolver, glyphOrigin, resolveSimpleEncoding, type Glyph,
} from './font.js';
import { Type1Font } from './type1.js';

export interface ImageOptions {
  /** Multiplier on the 72-DPI point size. Default 1. Ignored if width/height set. */
  scale?: number;
  /** Target pixel width. Overrides `scale`; height derived aspect-preserving unless also given. */
  width?: number;
  /** Target pixel height. Overrides `scale`; width derived aspect-preserving unless also given. */
  height?: number;
  /** Which page box defines the viewport. Default 'crop'. */
  box?: 'crop' | 'media';
  /** 'white' → opaque RGB PNG (default); 'transparent' → RGBA PNG, unpainted area transparent. */
  background?: 'white' | 'transparent';
  /** Composite annotation and form-field /AP appearances. Default true. */
  annotations?: boolean;
}


// ---------- Canvas (straight-alpha RGBA, 0..1) ----------

class Canvas {
  readonly data: Float32Array;
  /** Device-space origin of this canvas. Non-zero for offscreen buffers, which
   *  are allocated over the active clip bbox rather than the whole page. All
   *  drawing addresses this canvas in absolute device coordinates; the origin is
   *  subtracted here, so an offscreen is a window onto the same coordinate
   *  system rather than a separate one. */
  originX = 0;
  originY = 0;

  /** Group-only accumulated alpha. Allocated only for a non-isolated group's
   *  buffer, which is seeded with the backdrop: the alpha channel then holds
   *  the composite αn, and §11.4.6 backdrop removal needs the group's own αgn.
   *  It cannot be derived — αn = αgn + α0(1−αgn) inverts to
   *  (αn − α0)/(1 − α0), which is 0/0 wherever the backdrop is opaque, i.e.
   *  almost everywhere on a page rendered over white. */
  groupAlpha?: Float32Array;

  /** Geometric coverage (shape f_j, §11.4.8), before constant alpha (ca). Present
   *  only on a knockout element buffer, where the merge weight is the element's
   *  shape — not shape×ca — so a semi-transparent element still fully knocks out
   *  the elements beneath it within its footprint. */
  shape?: Float32Array;

  /** Frozen initial backdrop B0 of a knockout group (RGBA, straight alpha).
   *  Present only on a knockout group's accumulator: transparent when isolated,
   *  the page seed when non-isolated. Each element sub-buffer is seeded from it. */
  knockoutBackdrop?: Float32Array;

  /** This canvas's device-space window: [x0,x1) × [y0,y1). */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    return { x0: this.originX, y0: this.originY, x1: this.originX + this.w, y1: this.originY + this.h };
  }
  constructor(readonly w: number, readonly h: number, opaqueWhite: boolean) {
    this.data = new Float32Array(w * h * 4);
    if (opaqueWhite) this.data.fill(1);      // (1,1,1,1) everywhere
  }

  /** Source-over composite `color` at coverage `cov` (0..1) onto pixel (x,y),
   *  through blend function `mode` (PDF 32000-1 §11.3.5). */
  blend(x: number, y: number, color: Rgb, cov: number, mode: BlendMode = 'Normal', shapeCov = cov): void {
    if (cov <= 0) return;
    const lx = x - this.originX, ly = y - this.originY;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return;
    const i = (ly * this.w + lx) * 4;
    const d = this.data;
    const sa = cov > 1 ? 1 : cov;
    if (this.groupAlpha !== undefined) {
      const gi = ly * this.w + lx;
      this.groupAlpha[gi] = sa + this.groupAlpha[gi] * (1 - sa);
    }
    if (this.shape !== undefined) {
      const gi = ly * this.w + lx;
      const s = shapeCov > 1 ? 1 : shapeCov < 0 ? 0 : shapeCov;
      this.shape[gi] = s + this.shape[gi] * (1 - s);
    }
    const dr = d[i], dg = d[i + 1], db = d[i + 2], da = d[i + 3];
    const inv = 1 - sa;
    const oa = sa + da * inv;
    if (oa <= 0) return;
    let sr = color[0] / 255, sg = color[1] / 255, sb = color[2] / 255;
    if (mode !== 'Normal' && da > 0) {
      // Blend against the backdrop, weighted by backdrop alpha (§11.3.6): where
      // the backdrop is transparent the source shows through unblended.
      const [br, bg, bb] = blendPixel(mode, [dr, dg, db], [sr, sg, sb]);
      sr = sr * (1 - da) + br * da;
      sg = sg * (1 - da) + bg * da;
      sb = sb * (1 - da) + bb * da;
    }
    d[i]     = (sr * sa + dr * da * inv) / oa;
    d[i + 1] = (sg * sa + dg * da * inv) / oa;
    d[i + 2] = (sb * sa + db * da * inv) / oa;
    d[i + 3] = oa;
  }

  toPng(opaqueWhite: boolean): Uint8Array {
    const { w, h, data } = this;
    const to8 = (v: number) => { const n = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255); return n; };
    if (opaqueWhite) {
      const rgb = new Uint8Array(w * h * 3);
      for (let p = 0; p < w * h; p++) {
        rgb[p * 3]     = to8(data[p * 4]);
        rgb[p * 3 + 1] = to8(data[p * 4 + 1]);
        rgb[p * 3 + 2] = to8(data[p * 4 + 2]);
      }
      return encodePng(w, h, rgb, 'rgb');
    }
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h * 4; p++) rgba[p] = to8(data[p]);
    return encodePng(w, h, rgba, 'rgba');
  }
}

// ---------- Signed-area coverage accumulator (font-rs / AGG style) ----------

/** Accumulates signed trapezoidal area per cell; a horizontal prefix sum per row
 *  yields fractional coverage. Cells are the shape's local device bbox; indices
 *  are clamped so geometry running past the box degrades without corrupting. */
class Accumulator {
  private a: Float64Array;
  private stride: number;      // w + 2 (one carry cell + one guard)
  constructor(readonly w: number, readonly h: number) {
    this.stride = w + 2;
    this.a = new Float64Array(this.stride * h);
  }

  private add(row: number, col: number, v: number): void {
    const c = col < 0 ? 0 : col > this.w + 1 ? this.w + 1 : col;
    this.a[row + c] += v;
  }

  /** Accumulate one edge (device/local coords, y downward). */
  line(x0: number, y0: number, x1: number, y1: number): void {
    if (y0 === y1) return;
    let dir = 1;
    if (y0 > y1) { const tx = x0; x0 = x1; x1 = tx; const ty = y0; y0 = y1; y1 = ty; dir = -1; }
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    let p0y = y0;
    if (p0y < 0) { x -= p0y * dxdy; p0y = 0; }
    const yTop = Math.floor(p0y);
    const yBot = Math.min(this.h, Math.ceil(y1));
    for (let y = yTop; y < yBot; y++) {
      const row = y * this.stride;
      const dy = Math.min(y + 1, y1) - Math.max(y, p0y);
      if (dy <= 0) { continue; }
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = x, xb = xnext;
      const lo = xa < xb ? xa : xb;
      const hi = xa < xb ? xb : xa;
      const loFloor = Math.floor(lo);
      const x0i = loFloor;
      const x1i = Math.ceil(hi);
      if (x1i <= x0i + 1) {
        // spans a single pixel column
        const xmf = 0.5 * (xa + xb) - loFloor;
        this.add(row, x0i, d - d * xmf);
        this.add(row, x0i + 1, d * xmf);
      } else {
        const s = 1 / (hi - lo);
        const x0f = lo - loFloor;
        const aM = 1 - x0f;
        const x1f = hi - x1i + 1;
        const am = 0.5 * s * aM * aM;      // covered area of first partial cell
        const bm = 0.5 * s * x1f * x1f;    // covered area of last partial cell
        this.add(row, x0i, d * am);
        if (x1i === x0i + 2) {
          this.add(row, x0i + 1, d * (1 - am - bm));
        } else {
          const a1 = s * (1.5 - x0f);
          this.add(row, x0i + 1, d * (a1 - am));
          for (let xi = x0i + 2; xi < x1i - 1; xi++) this.add(row, xi, d * s);
          const a2 = a1 + (x1i - x0i - 3) * s;
          this.add(row, x1i - 1, d * (1 - a2 - bm));
        }
        this.add(row, x1i, d * bm);
      }
      x = xnext;
    }
  }

  /** Sweep local cells to fractional coverage under the winding rule, invoking
   *  `cb(x, y, cov)` for each covered cell (local coords). */
  private sweep(evenOdd: boolean, cb: (x: number, y: number, cov: number) => void): void {
    for (let y = 0; y < this.h; y++) {
      const row = y * this.stride;
      let acc = 0;
      for (let x = 0; x < this.w; x++) {
        acc += this.a[row + x];
        let cov: number;
        if (evenOdd) {
          const m = Math.abs(acc) % 2;
          cov = m > 1 ? 2 - m : m;
        } else {
          const av = Math.abs(acc);
          cov = av > 1 ? 1 : av;
        }
        if (cov > 1e-4) cb(x, y, cov);
      }
    }
  }

  /** Sweep to coverage and composite onto `canvas` at (ox,oy), applying the
   *  winding rule and scaling by the paint's clip × soft mask × alpha. */
  composite(canvas: Canvas, ox: number, oy: number, color: Rgb, evenOdd: boolean, paint: Paint): void {
    this.sweep(evenOdd, (x, y, cov) => {
      const px = ox + x, py = oy + y;
      const c = cov * paint.at(px, py);
      if (c <= 1e-4) return;
      const shp = canvas.shape !== undefined ? cov * paint.shapeAt(px, py) : c;
      canvas.blend(px, py, color, c, paint.blend, shp);
    });
  }

  /** Sweep to a coverage buffer for the local bbox (row-major, `w`×`h`). */
  coverage(evenOdd: boolean): Float32Array {
    const m = new Float32Array(this.w * this.h);
    this.sweep(evenOdd, (x, y, cov) => { m[y * this.w + x] = cov > 1 ? 1 : cov; });
    return m;
  }
}

// ---------- Clip mask (device-space coverage over a tracked bbox) ----------

/** A rasterized clip: fractional coverage 0..1 over `[x0,x1)×[y0,y1)`; fully
 *  transparent (0) outside the bbox. Lazily built and intersected on nested clips. */
class ClipMask {
  constructor(
    readonly x0: number, readonly y0: number, readonly x1: number, readonly y1: number,
    readonly data: Float32Array,
  ) {}

  at(px: number, py: number): number {
    if (px < this.x0 || px >= this.x1 || py < this.y0 || py >= this.y1) return 0;
    return this.data[(py - this.y0) * (this.x1 - this.x0) + (px - this.x0)];
  }

  /** Intersect with another mask: coverage is the product over the overlap bbox. */
  intersect(other: ClipMask): ClipMask {
    const x0 = Math.max(this.x0, other.x0), y0 = Math.max(this.y0, other.y0);
    const x1 = Math.min(this.x1, other.x1), y1 = Math.min(this.y1, other.y1);
    if (x1 <= x0 || y1 <= y0) return new ClipMask(0, 0, 0, 0, new Float32Array(0));
    const w = x1 - x0;
    const data = new Float32Array(w * (y1 - y0));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const v = this.at(x, y) * other.at(x, y);
        if (v > 0) data[(y - y0) * w + (x - x0)] = v;
      }
    return new ClipMask(x0, y0, x1, y1, data);
  }
}

/** Everything that scales a paint operation's coverage, bundled so the five
 *  rasterize* entry points take one parameter instead of four: the clip, the
 *  soft mask (a separate slot — /SMask /None clears it without touching the
 *  clip), constant alpha (ca/CA), and the blend mode. */
class Paint {
  constructor(
    readonly clip?: ClipMask,
    readonly softMask?: ClipMask,
    readonly alpha: number = 1,
    readonly blend: BlendMode = 'Normal',
  ) {}

  /** Combined coverage multiplier at a device pixel: clip × softMask × alpha. */
  at(px: number, py: number): number {
    let v = this.alpha;
    if (v <= 0) return 0;
    if (this.clip) { v *= this.clip.at(px, py); if (v <= 0) return 0; }
    if (this.softMask) v *= this.softMask.at(px, py);
    return v;
  }

  /** Coverage multiplier WITHOUT constant alpha: clip × softMask. This is the
   *  §11.4.8 shape, used to weight the knockout merge. */
  shapeAt(px: number, py: number): number {
    let v = 1;
    if (this.clip) { v *= this.clip.at(px, py); if (v <= 0) return 0; }
    if (this.softMask) v *= this.softMask.at(px, py);
    return v;
  }

  /** Device region this paint can touch, clamped to a canvas's device window. */
  bounds(cb: { x0: number; y0: number; x1: number; y1: number }): { x0: number; y0: number; x1: number; y1: number } {
    const c = this.clip;
    return {
      x0: Math.max(cb.x0, c ? c.x0 : cb.x0), y0: Math.max(cb.y0, c ? c.y0 : cb.y0),
      x1: Math.min(cb.x1, c ? c.x1 : cb.x1), y1: Math.min(cb.y1, c ? c.y1 : cb.y1),
    };
  }
}

// ---------- Fill ----------

/** Accumulate closed device-space polylines into an accumulator over their bbox
 *  (clamped to `[0,w)×[0,h)`), returning the accumulator and its origin — or
 *  undefined when the geometry is empty/off-canvas. Shared by fill and clip. */
function accumulatePolys(polys: Poly[], b: { x0: number; y0: number; x1: number; y1: number }):
  { acc: Accumulator; ox: number; oy: number } | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) {
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return undefined;
  const ix0 = Math.max(b.x0, Math.floor(minX));
  const iy0 = Math.max(b.y0, Math.floor(minY));
  const ix1 = Math.min(b.x1, Math.ceil(maxX));
  const iy1 = Math.min(b.y1, Math.ceil(maxY));
  const lw = ix1 - ix0, lh = iy1 - iy0;
  if (lw <= 0 || lh <= 0) return undefined;

  const acc = new Accumulator(lw, lh);
  for (const p of polys) {
    const n = p.length;
    if (n < 4) continue;         // need at least 2 points
    // Close the subpath for filling.
    if (p[0] !== p[n - 2] || p[1] !== p[n - 1]) p.push(p[0], p[1]);
    for (let i = 0; i + 3 < p.length; i += 2) {
      acc.line(p[i] - ix0, p[i + 1] - iy0, p[i + 2] - ix0, p[i + 3] - iy0);
    }
  }
  return { acc, ox: ix0, oy: iy0 };
}

function rasterizeFill(canvas: Canvas, polys: Poly[], color: Rgb, evenOdd: boolean, paint: Paint): void {
  const r = accumulatePolys(polys, canvas.bounds());
  if (r) r.acc.composite(canvas, r.ox, r.oy, color, evenOdd, paint);
}

/** Rasterize a clip path (device space) to a coverage mask over its bbox. Returns
 *  an empty mask when the path covers nothing (clips everything out). */
function rasterizeClip(path: Path, ctm: Matrix, evenOdd: boolean, b: { x0: number; y0: number; x1: number; y1: number }): ClipMask {
  const polys = flattenPath(path, ctm);
  const r = accumulatePolys(polys, b);
  if (!r) return new ClipMask(0, 0, 0, 0, new Float32Array(0));
  const lw = r.acc.w, lh = r.acc.h;
  return new ClipMask(r.ox, r.oy, r.ox + lw, r.oy + lh, r.acc.coverage(evenOdd));
}

// ---------- Stroking (outline from strokegeom, filled or accumulated here) ----------

function rasterizeStroke(canvas: Canvas, path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle, paint: Paint): void {
  const polys = strokeOutlinePolys(path, ctm, style);
  if (polys.length) rasterizeFill(canvas, polys, color, false, paint);
}

/** The stroke outline as a coverage mask — rasterizeClip, but for a stroke. */
/** A clip mask covering `polys` (device space, nonzero winding). */
function polysClipMask(polys: Poly[], b: { x0: number; y0: number; x1: number; y1: number }): ClipMask {
  const r = accumulatePolys(polys, b);
  if (!r) return new ClipMask(0, 0, 0, 0, new Float32Array(0));
  return new ClipMask(r.ox, r.oy, r.ox + r.acc.w, r.oy + r.acc.h, r.acc.coverage(false));
}

function strokeClipMask(path: Path, ctm: Matrix, style: StrokeStyle, b: { x0: number; y0: number; x1: number; y1: number }): ClipMask {
  return polysClipMask(strokeOutlinePolys(path, ctm, style), b);
}

// ---------- Images (decode → RGBA, inverse-mapped bilinear sampling) ----------

/** A decoded image as straight-alpha RGBA (8-bit), row 0 = top. */
/** Bilinearly sample straight-alpha RGBA at (u,v) ∈ [0,1); edges clamp. */
function sampleBilinear(img: ImageRgba, u: number, v: number, out: [number, number, number, number]): void {
  const fx = u * img.w - 0.5, fy = v * img.h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const cl = (n: number, m: number) => (n < 0 ? 0 : n > m ? m : n);
  const x0c = cl(x0, img.w - 1), x1c = cl(x0 + 1, img.w - 1);
  const y0c = cl(y0, img.h - 1), y1c = cl(y0 + 1, img.h - 1);
  const d = img.data;
  for (let c = 0; c < 4; c++) {
    const a = d[(y0c * img.w + x0c) * 4 + c], b = d[(y0c * img.w + x1c) * 4 + c];
    const e = d[(y1c * img.w + x0c) * 4 + c], f = d[(y1c * img.w + x1c) * 4 + c];
    const top = a + (b - a) * tx, bot = e + (f - e) * tx;
    out[c] = top + (bot - top) * ty;
  }
}

/** Paint `img` over the unit square mapped by `ctm`: inverse-map each device pixel
 *  in the transformed bbox to image UV (row 0 at top → v = 1 − y), sample bilinear,
 *  and composite under the active clip. */
function rasterizeImage(canvas: Canvas, img: ImageRgba, ctm: Matrix, paint: Paint): void {
  const [a, b, c, d, e, f] = ctm;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const [dx, dy] = apply(ctm, cx, cy);
    if (dx < minX) minX = dx; if (dx > maxX) maxX = dx;
    if (dy < minY) minY = dy; if (dy > maxY) maxY = dy;
  }
  const cb = canvas.bounds();
  const ix0 = Math.max(cb.x0, Math.floor(minX)), iy0 = Math.max(cb.y0, Math.floor(minY));
  const ix1 = Math.min(cb.x1, Math.ceil(maxX)), iy1 = Math.min(cb.y1, Math.ceil(maxY));

  const px: [number, number, number, number] = [0, 0, 0, 0];
  const color: Rgb = [0, 0, 0];
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      const sx = x + 0.5 - e, sy = y + 0.5 - f;
      const ux = (d * sx - c * sy) / det;
      const uy = (a * sy - b * sx) / det;
      if (ux < 0 || ux >= 1 || uy < 0 || uy >= 1) continue;
      sampleBilinear(img, ux, 1 - uy, px);
      let cov = px[3] / 255;
      if (cov <= 1e-4) continue;
      cov *= paint.at(x, y);
      if (cov <= 1e-4) continue;
      color[0] = px[0]; color[1] = px[1]; color[2] = px[2];
      canvas.blend(x, y, color, cov, paint.blend);
    }
  }
}

// ---------- Text glyphs (glyf outlines → nonzero fill; placeholder boxes) ----------

/** The embedded-font handle for one PDF font dict, resolved once and cached. */
export interface GlyphSource {
  sfnt?: SfntFont;             // parsed sfnt: glyf outlines and/or a cmap for gid lookup
  cff?: CffFont;               // CFF outlines (FontFile3 / OpenType-CFF)
  type1?: Type1Font;           // Type 1 outlines (/FontFile)
  isType0: boolean;            // composite font: code = CID
  cidToGid?: Uint8Array;       // /CIDToGIDMap stream (2 bytes/CID); undefined → identity
  /** code -> glyph name, for the name-keyed programs. Undefined for a composite
   *  font and for a face resolved through a cmap. */
  nameForCode?: (code: number) => string | undefined;
}


const HAIRLINE_STYLE: StrokeStyle = { width: 0, cap: 0, join: 0, miter: 10, dash: [], dashPhase: 0 };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function buildGlyphSource(doc: Document, fontDict: PdfDict): GlyphSource {
  const sub = doc.resolve(fontDict.get('Subtype'));
  const isType0 = isName(sub) && sub.name === 'Type0';
  let fd: PdfObject | undefined;
  let cidToGid: Uint8Array | undefined;
  if (isType0) {
    const dfs = doc.resolve(fontDict.get('DescendantFonts'));
    const df = isArray(dfs) ? doc.resolve(dfs[0]) : undefined;
    if (isDict(df)) {
      fd = doc.resolve(df.get('FontDescriptor'));
      const c2g = doc.resolve(df.get('CIDToGIDMap'));
      if (isStream(c2g)) { try { cidToGid = inflateStream(c2g as Parameters<typeof inflateStream>[0]); } catch { /* identity */ } }
    }
  } else {
    fd = doc.resolve(fontDict.get('FontDescriptor'));
  }
  const prog = loadEmbeddedProgram(fd, (o) => doc.resolve(o),
    (s) => inflateStream(s as Parameters<typeof inflateStream>[0]));
  let sfnt = prog.sfnt;
  const cff = prog.cff;
  const type1 = prog.type1;

  // Non-embedded simple font: substitute the bundled Standard-14 outline face.
  // The resulting sfnt's Unicode cmap + glyf outlines flow through the existing
  // gidForCode/glyphOutline path; PDF /Widths still drive advances.
  if (!sfnt && !cff && !type1 && !isType0) {
    const bf = doc.resolve(fontDict.get('BaseFont'));
    sfnt = getStd14Sfnt(normalizeFont(isName(bf) ? bf.name : 'Helvetica'));
  }

  // The name route, for the two name-keyed program kinds. A face with a usable
  // cmap keeps the cmap: it is the font's own answer and is already proven.
  let nameForCode: ((code: number) => string | undefined) | undefined;
  if (!isType0 && (type1 || (cff && !sfnt?.cmap.size))) {
    nameForCode = glyphNameResolver(
      resolveSimpleEncoding(fontDict, (o) => doc.resolve(o)),
      type1?.builtinEncodingNames(),
    );
  }
  return { sfnt, cff, type1, isType0, cidToGid, nameForCode };
}

/** Resolve a character/CID code to a glyph id in the embedded program. */
export function gidForCode(src: GlyphSource, code: number, text: string): number | undefined {
  // The CID route is glyphprogram.ts's, shared with font.ts's width lookup —
  // a second copy is how the drawn glyph and the measured glyph come to
  // disagree about one document.
  if (src.isType0) return gidForCid(src, code, src.cidToGid);
  return gidForProgram(src, code, text, src.nameForCode);
}

/** Outline a low-coverage placeholder box for a non-embedded glyph, in em space. */
function drawGlyphPlaceholder(canvas: Canvas, emMatrix: Matrix, widthEm: number, color: Rgb, paint: Paint): void {
  const x0 = 0.08, x1 = widthEm - 0.08;
  if (x1 <= x0) return;
  const box: Path = [
    { op: 'M', x: x0, y: 0 }, { op: 'L', x: x1, y: 0 },
    { op: 'L', x: x1, y: 0.62 }, { op: 'L', x: x0, y: 0.62 }, { op: 'Z' },
  ];
  rasterizeStroke(canvas, box, emMatrix, color, HAIRLINE_STYLE, paint);
}

/** Walk a run's glyphs, handing each its em→device matrix and its outline
 *  polygons (empty when the glyph has none, undefined when no gid resolved).
 *  The advance rule is shared by drawing a run and by clipping to it, so it
 *  lives here rather than being written twice. */
function eachGlyph(
  info: TextRunInfo, src: GlyphSource | undefined,
  fn: (g: Glyph, emMatrix: Matrix, polys: Poly[] | undefined) => void,
): void {
  const glyphs = info.font.decodeGlyphs(info.bytes);
  const base = mul(info.tm, info.ctm);
  const param: Matrix = [info.fontSize * info.hscale, 0, 0, info.fontSize, 0, info.rise];
  let advX = 0, advY = 0;
  for (const g of glyphs) {
    const [ox, oy] = glyphOrigin(g, advX, advY, info.fontSize, info.hscale);
    const emMatrix = mul(param, mul(translate(ox, oy), base));
    let polys: Poly[] | undefined;
    if (src?.cff || src?.sfnt || src?.type1) {
      // A composite font selects its glyph by CID, which the /Encoding CMap
      // produced; only under Identity is that the code itself.
      const gid = gidForCode(src, src.isType0 ? g.cid : g.code, g.text);
      if (gid !== undefined) polys = glyphPolys(src, gid, emMatrix);   // may be [] for a blank glyph
    }
    fn(g, emMatrix, polys);
    const [dx, dy] = glyphDisplacement(g, info.fontSize, info.charSp, info.wordSp, info.hscale);
    advX += dx; advY += dy;
  }
}

function rasterizeGlyphRun(canvas: Canvas, info: TextRunInfo, src: GlyphSource | undefined, paint: Paint): void {
  eachGlyph(info, src, (g, emMatrix, polys) => {
    if (polys) {                                    // gid resolved (empty glyph → no box)
      if (polys.length) rasterizeFill(canvas, polys, info.color, false, paint);
      return;
    }
    if (!g.isWordSpace && g.width > 0.005) drawGlyphPlaceholder(canvas, emMatrix, g.width, info.color, paint);
  });
}

/** Every outline polygon of a run, in device space — the geometry a pattern fill
 *  clips to. Empty when no glyph resolved to an outline, which is the caller's
 *  signal to draw the run solid instead of clipping it away to nothing. */
function glyphRunPolys(info: TextRunInfo, src: GlyphSource | undefined): Poly[] {
  const out: Poly[] = [];
  eachGlyph(info, src, (_g, _m, polys) => { if (polys) out.push(...polys); });
  return out;
}

// ---------- Shadings (axial/radial gradients sampled per device pixel) ----------

const MID_GRAY: Rgb = [128, 128, 128];

/** A gradient sampler: maps a shading-space point to an RGB color, or undefined
 *  where the shading paints nothing (outside a non-extended axis/circle). */
type ShadingEval = (px: number, py: number) => Rgb | undefined;

/** Build a 257-entry color LUT over the parametric domain `[t0,t1]`, so the
 *  per-pixel loop indexes instead of re-evaluating the (possibly costly) function. */
function shadingLut(fn: (x: number[]) => number[], cs: ColorConverter, t0: number, t1: number): Rgb[] {
  const N = 256;
  const lut: Rgb[] = new Array(N + 1);
  for (let i = 0; i <= N; i++) lut[i] = cs.toRgb(fn([t0 + (i / N) * (t1 - t0)]));
  return lut;
}
function lutAt(lut: Rgb[], s: number): Rgb {
  const i = Math.round((s < 0 ? 0 : s > 1 ? 1 : s) * (lut.length - 1));
  return lut[i];
}

/** Axial (type 2): project onto the axis and clamp/extend at the ends. */
function axialEval(coords: number[], lut: Rgb[], ext0: boolean, ext1: boolean): ShadingEval {
  const x0 = coords[0], y0 = coords[1];
  const dx = coords[2] - x0, dy = coords[3] - y0;
  const dd = dx * dx + dy * dy;
  return (px, py) => {
    let s = dd === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / dd;
    if (s < 0) { if (!ext0) return undefined; s = 0; }
    else if (s > 1) { if (!ext1) return undefined; s = 1; }
    return lutAt(lut, s);
  };
}

/** Radial (type 3): largest parameter `s` whose interpolated circle (with
 *  non-negative radius) passes through the point; clamp/extend beyond the ends. */
function radialEval(coords: number[], lut: Rgb[], ext0: boolean, ext1: boolean): ShadingEval {
  const x0 = coords[0], y0 = coords[1], r0 = coords[2];
  const dcx = coords[3] - x0, dcy = coords[4] - y0, dr = coords[5] - r0;
  const a = dcx * dcx + dcy * dcy - dr * dr;
  return (px, py) => {
    const fx = px - x0, fy = py - y0;
    const b = 2 * (fx * dcx + fy * dcy + r0 * dr);
    const c = fx * fx + fy * fy - r0 * r0;
    let s1: number, s2: number;
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) < 1e-12) return undefined;
      s1 = s2 = c / b;
    } else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return undefined;
      const sq = Math.sqrt(disc);
      s1 = (b + sq) / (2 * a);
      s2 = (b - sq) / (2 * a);
    }
    // Try the larger root first: it yields the frontmost circle at this pixel.
    for (const s of s1 >= s2 ? [s1, s2] : [s2, s1]) {
      if (r0 + s * dr < 0) continue;                 // interpolated radius must be ≥ 0
      if (s >= 0 && s <= 1) return lutAt(lut, s);
      if (s > 1 && ext1) return lutAt(lut, 1);
      if (s < 0 && ext0) return lutAt(lut, 0);
    }
    return undefined;
  };
}

/** Rasterize an axial/radial shading (the `sh` operator) over the active clip.
 *  Unsupported shading types degrade to a mid-gray fill of the same region. */
function rasterizeShading(canvas: Canvas, doc: Document, dict: PdfDict, ctm: Matrix, paint: Paint): void {
  const [a, b, c, d, e, f] = ctm;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return;                 // singular CTM → nothing maps

  // Paint region: the clip bbox, else the whole canvas (an unclipped `sh` fills it).
  const { x0: ix0, y0: iy0, x1: ix1, y1: iy1 } = paint.bounds(canvas.bounds());
  if (ix1 <= ix0 || iy1 <= iy0) return;

  const r = (o: PdfObject | undefined) => doc.resolve(o);
  const infl = (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]);
  const type = resolveNum(doc, dict.get('ShadingType'), 0);
  const coords = arrNums(doc, dict.get('Coords'));
  const supported = (type === 2 && coords.length >= 4) || (type === 3 && coords.length >= 6);

  let evalShade: ShadingEval;
  if (supported) {
    const csObj = dict.get('ColorSpace');
    const cs = csObj !== undefined ? resolveColorSpace(csObj, r, infl) : localDeviceGray();
    const dom = arrNums(doc, dict.get('Domain'));
    const t0 = dom.length >= 2 ? dom[0] : 0;
    const t1 = dom.length >= 2 ? dom[1] : 1;
    const ext = r(dict.get('Extend'));
    const ext0 = isArray(ext) && r(ext[0]) === true;
    const ext1 = isArray(ext) && r(ext[1]) === true;
    const fnObj = dict.get('Function');
    const fn = fnObj !== undefined ? parseFunction(fnObj, r, infl) : (x: number[]) => x;
    const lut = shadingLut(fn, cs, t0, t1);
    evalShade = type === 2 ? axialEval(coords, lut, ext0, ext1) : radialEval(coords, lut, ext0, ext1);
  } else {
    evalShade = () => MID_GRAY;                       // degrade: flat mid-gray
  }

  const color: Rgb = [0, 0, 0];
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      const cov = paint.at(x, y);
      if (cov <= 1e-4) continue;
      // Device pixel center → shading space via the inverse CTM.
      const sx = x + 0.5 - e, sy = y + 0.5 - f;
      const ux = (d * sx - c * sy) / det;
      const uy = (a * sy - b * sx) / det;
      const col = evalShade(ux, uy);
      if (!col) continue;
      color[0] = col[0]; color[1] = col[1]; color[2] = col[2];
      canvas.blend(x, y, color, cov, paint.blend);
    }
  }
}

// ---------- Raster sink ----------

/** RenderSink that composites onto an RGBA canvas. Implements anti-aliased fills
 *  (3sh.2.2), strokes (3sh.2.3), a clip-mask coverage stack (3sh.2.4), affine image
 *  sampling (3sh.2.5), and glyph outlines from embedded TrueType (glyf) and CFF
 *  (Type2 charstrings) fonts, bundled Standard-14 outlines for non-embedded
 *  faces (3sh.3), and axial/radial shadings via the `sh` operator (3sh.4). */
class RasterSink implements RenderSink {
  private paint = new Paint();
  private fillAlpha = 1;
  private strokeAlpha = 1;
  private stack: { paint: Paint; fillAlpha: number; strokeAlpha: number }[] = [];
  private offscreen: {
    canvas: Canvas; saved: Canvas;
    savedPaint: Paint; savedFillAlpha: number; savedStrokeAlpha: number;
  }[] = [];
  /** Active knockout-element sub-buffers: E is the element buffer, G the group
   *  accumulator to merge back into. `null` is a marker pushed when the current
   *  canvas is not a knockout group, so begin/end stay paired. */
  private knockoutStack: ({ E: Canvas; G: Canvas } | null)[] = [];
  private glyphSources = new Map<PdfDict, GlyphSource>();

  constructor(
    private doc: Document, private canvas: Canvas,
    /** Skip every glyph run. `renderPageGraphicsToPng`'s whole difference from
     *  `renderPageToPng`: the HTML fixed-mode `backdrop: 'raster'` layer draws
     *  its text as real HTML spans, so glyphs baked into the backdrop would be
     *  drawn twice, once here and once by the browser with a substituted face. */
    private skipGlyphs = false,
  ) {}

  save(): void {
    this.stack.push({ paint: this.paint, fillAlpha: this.fillAlpha, strokeAlpha: this.strokeAlpha });
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) { this.paint = s.paint; this.fillAlpha = s.fillAlpha; this.strokeAlpha = s.strokeAlpha; }
  }

  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void {
    const mask = rasterizeClip(path, ctm, evenOdd, this.canvas.bounds());
    const clip = this.paint.clip ? this.paint.clip.intersect(mask) : mask;
    this.paint = new Paint(clip, this.paint.softMask, this.paint.alpha, this.paint.blend);
  }

  setAlpha(fill: number, stroke: number): void { this.fillAlpha = fill; this.strokeAlpha = stroke; }
  setBlend(mode: BlendMode): void {
    this.paint = new Paint(this.paint.clip, this.paint.softMask, this.paint.alpha, mode);
  }

  clearSoftMask(): void {
    this.paint = new Paint(this.paint.clip, undefined, this.paint.alpha, this.paint.blend);
  }

  clipToStroke(path: Path, ctm: Matrix, style: StrokeStyle): void {
    this.narrowClip(strokeClipMask(path, ctm, style, this.canvas.bounds()));
  }

  clipToGlyphs(info: TextRunInfo): boolean {
    // No outline for any glyph in the run — a font we could not parse, or one
    // drawn as placeholder boxes. Clipping to nothing would erase the text, so
    // decline and let the caller paint it solid.
    const polys = glyphRunPolys(info, this.glyphSourceFor(info));
    if (!polys.length) return false;
    this.narrowClip(polysClipMask(polys, this.canvas.bounds()));
    return true;
  }

  private narrowClip(mask: ClipMask): void {
    const clip = this.paint.clip ? this.paint.clip.intersect(mask) : mask;
    this.paint = new Paint(clip, this.paint.softMask, this.paint.alpha, this.paint.blend);
  }

  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    opts?: { backdrop?: boolean; knockout?: boolean },
  ): void {
    // Cap a single buffer's area, so a pathological pattern matrix cannot ask
    // for an unbounded allocation.
    const MAX_OFFSCREEN_PIXELS = 4096 * 4096;
    const b = region ?? this.paint.bounds(this.canvas.bounds());
    const wantW = Math.max(1, b.x1 - b.x0), wantH = Math.max(1, b.y1 - b.y0);
    const frame = {
      saved: this.canvas, savedPaint: this.paint,
      savedFillAlpha: this.fillAlpha, savedStrokeAlpha: this.strokeAlpha,
    };
    if (this.offscreen.length >= MAX_OFFSCREEN_DEPTH || wantW * wantH > MAX_OFFSCREEN_PIXELS) {
      // Depth or size cap: push a marker that endOffscreen recognizes and
      // ignores, so the construct degrades instead of allocating further.
      this.offscreen.push({ canvas: this.canvas, ...frame });
      return;
    }
    // Allocate over the requested region, not the page: a small masked logo
    // costs a few KB rather than the ~30 MB a full-page Float32Array takes at
    // scale 4.
    const sub = new Canvas(wantW, wantH, false);
    sub.originX = b.x0; sub.originY = b.y0;
    if (opts?.backdrop) {
      // Non-isolated group: seed with the backdrop so inner blend modes see the
      // page, and track group-only alpha so composeGroup can subtract the seed
      // back out (§11.4.6). `this.canvas` is still the parent here.
      sub.groupAlpha = new Float32Array(wantW * wantH);
      const par = this.canvas;
      for (let y = 0; y < wantH; y++) {
        const py = b.y0 + y - par.originY;
        if (py < 0 || py >= par.h) continue;
        for (let x = 0; x < wantW; x++) {
          const px = b.x0 + x - par.originX;
          if (px < 0 || px >= par.w) continue;
          const si = (py * par.w + px) * 4;
          const di = (y * wantW + x) * 4;
          sub.data[di]     = par.data[si];
          sub.data[di + 1] = par.data[si + 1];
          sub.data[di + 2] = par.data[si + 2];
          sub.data[di + 3] = par.data[si + 3];
        }
      }
    }
    if (opts?.knockout) {
      // Freeze the group's initial backdrop: transparent (zeros) when isolated,
      // the page seed when non-isolated. Each element sub-buffer is seeded from
      // this, and — non-isolated — the group also needs its own αgn for removal.
      sub.knockoutBackdrop = sub.data.slice();
      if (opts.backdrop && sub.groupAlpha === undefined) sub.groupAlpha = new Float32Array(wantW * wantH);
    }
    this.offscreen.push({ canvas: sub, ...frame });
    this.canvas = sub;
    // Contents render unclipped and at full strength: the outer clip, soft mask,
    // alpha and blend all apply when the buffer composites down, not while it is
    // being filled. A tiling cell in particular lives outside the region it
    // fills, so drawing it through the outer clip would erase it.
    this.paint = new Paint();
    this.fillAlpha = 1; this.strokeAlpha = 1;
  }

  endOffscreen(use: OffscreenUse): void {
    const top = this.offscreen.pop();
    if (!top) return;
    const buf = this.canvas;
    this.canvas = top.saved;
    this.paint = top.savedPaint;
    this.fillAlpha = top.savedFillAlpha;
    this.strokeAlpha = top.savedStrokeAlpha;
    if (buf === top.saved) return;              // depth cap hit: nothing buffered
    if (use.kind === 'softmask') this.applySoftMask(buf, use);
    else if (use.kind === 'tile') this.blitTile(buf, use);
    else this.composeGroup(buf, use);
  }

  beginKnockoutElement(): void {
    const G = this.canvas;
    if (G.knockoutBackdrop === undefined) { this.knockoutStack.push(null); return; }
    // A sub-buffer congruent to the group accumulator, seeded with B0. It tracks
    // element-only alpha (groupAlpha) and geometric shape. The current paint
    // (clip / soft mask / ca) is kept: the element draws in the group's state.
    const E = new Canvas(G.w, G.h, false);
    E.originX = G.originX; E.originY = G.originY;
    E.data.set(G.knockoutBackdrop);
    E.groupAlpha = new Float32Array(G.w * G.h);
    E.shape = new Float32Array(G.w * G.h);
    this.knockoutStack.push({ E, G });
    this.canvas = E;
  }

  endKnockoutElement(): void {
    const top = this.knockoutStack.pop();
    if (!top) return;
    const { E, G } = top;
    this.canvas = G;
    // Knockout merge (§11.4.8): where the element has shape f, replace the
    // accumulator with the element's result over B0; elsewhere leave it. Worked
    // in premultiplied space so differing alphas compose correctly.
    const shp = E.shape!;
    const n = G.w * G.h;
    for (let i = 0; i < n; i++) {
      const f = shp[i];
      if (f <= 0) continue;
      const gi = i * 4;
      const ea = E.data[gi + 3], ga = G.data[gi + 3];
      const na = (1 - f) * ga + f * ea;
      G.data[gi + 3] = na;
      if (na > 0) {
        G.data[gi]     = ((1 - f) * G.data[gi]     * ga + f * E.data[gi]     * ea) / na;
        G.data[gi + 1] = ((1 - f) * G.data[gi + 1] * ga + f * E.data[gi + 1] * ea) / na;
        G.data[gi + 2] = ((1 - f) * G.data[gi + 2] * ga + f * E.data[gi + 2] * ea) / na;
      }
      if (G.groupAlpha !== undefined) {
        G.groupAlpha[i] = (1 - f) * G.groupAlpha[i] + f * E.groupAlpha![i];
      }
    }
  }

  /** Replicate an offscreen cell across the clip bbox on the pattern lattice.
   *  Past MAX_TILE_BLITS the fill degrades to the cell's mean color — bounded,
   *  and strictly better than the mid-gray it replaces. */
  private blitTile(buf: Canvas, use: Extract<OffscreenUse, { kind: 'tile' }>): void {
    const p = this.paintFor('fill');
    const b = p.bounds(this.canvas.bounds());
    if (b.x1 <= b.x0 || b.y1 <= b.y0) return;

    // Device-space step vectors: one XStep / YStep under the pattern matrix.
    const [ma, mb, mc, md] = use.matrix;
    const sxx = ma * use.xstep, sxy = mb * use.xstep;
    const syx = mc * use.ystep, syy = md * use.ystep;
    const stepX = Math.hypot(sxx, sxy), stepY = Math.hypot(syx, syy);
    if (!(stepX >= 0.5) || !(stepY >= 0.5)) { this.fillMean(buf, p, b); return; }

    // Which lattice indices (i,j) can reach the target box? Invert the lattice
    // basis and map the box's corners back into index space. Doing it this way
    // rather than marching i/j from a scalar step is what makes reflected and
    // rotated pattern matrices work — under the PDF y-flip the Y step points
    // up, so a naive forward walk marches away from the region.
    const det = sxx * syy - syx * sxy;
    if (Math.abs(det) < 1e-12) { this.fillMean(buf, p, b); return; }
    let iMin = Infinity, iMax = -Infinity, jMin = Infinity, jMax = -Infinity;
    for (const [cx, cy] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
      const rx = cx - buf.originX, ry = cy - buf.originY;
      const i = (syy * rx - syx * ry) / det;
      const j = (sxx * ry - sxy * rx) / det;
      if (i < iMin) iMin = i; if (i > iMax) iMax = i;
      if (j < jMin) jMin = j; if (j > jMax) jMax = j;
    }
    // Pad by the cell's overhang: a cell larger than its step overlaps neighbors.
    const padI = Math.ceil(buf.w / stepX) + 1;
    const padJ = Math.ceil(buf.h / stepY) + 1;
    const i0 = Math.floor(iMin) - padI, i1 = Math.ceil(iMax) + padI;
    const j0 = Math.floor(jMin) - padJ, j1 = Math.ceil(jMax) + padJ;

    const count = (i1 - i0 + 1) * (j1 - j0 + 1);
    if (!Number.isFinite(count) || count > MAX_TILE_BLITS) { this.fillMean(buf, p, b); return; }

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const ox = Math.round(buf.originX + i * sxx + j * syx);
        const oy = Math.round(buf.originY + i * sxy + j * syy);
        this.blitAt(buf, ox, oy, p, b);
      }
    }
  }

  /** Source-over one offscreen cell at a device offset, through `p`. */
  private blitAt(
    buf: Canvas, ox: number, oy: number, p: Paint,
    b: { x0: number; y0: number; x1: number; y1: number },
  ): void {
    if (ox >= b.x1 || oy >= b.y1 || ox + buf.w <= b.x0 || oy + buf.h <= b.y0) return;
    for (let y = 0; y < buf.h; y++) {
      const dy = oy + y;
      if (dy < b.y0 || dy >= b.y1) continue;
      for (let x = 0; x < buf.w; x++) {
        const dx = ox + x;
        if (dx < b.x0 || dx >= b.x1) continue;
        const i = (y * buf.w + x) * 4;
        const sa = buf.data[i + 3];
        if (sa <= 0) continue;
        const cov = sa * p.at(dx, dy);
        if (cov <= 1e-4) continue;
        const col: Rgb = [buf.data[i] * 255, buf.data[i + 1] * 255, buf.data[i + 2] * 255];
        this.canvas.blend(dx, dy, col, cov, p.blend);
      }
    }
  }

  /** Budget fallback: flat fill with the cell's alpha-weighted mean color. */
  private fillMean(
    buf: Canvas, p: Paint, b: { x0: number; y0: number; x1: number; y1: number },
  ): void {
    let r = 0, g = 0, bl = 0, aw = 0;
    const n = buf.w * buf.h;
    for (let i = 0; i < n; i++) {
      const a = buf.data[i * 4 + 3];
      r += buf.data[i * 4] * a; g += buf.data[i * 4 + 1] * a; bl += buf.data[i * 4 + 2] * a; aw += a;
    }
    if (aw <= 0) return;
    const col: Rgb = [(r / aw) * 255, (g / aw) * 255, (bl / aw) * 255];
    const cov = aw / n;
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < b.x1; x++) {
        const c = cov * p.at(x, y);
        if (c > 1e-4) this.canvas.blend(x, y, col, c, p.blend);
      }
  }

  /** Composite an offscreen group down: one source-over of the already-flattened
   *  buffer, scaled by group alpha and through the group's blend mode.
   *  Compositing once is exactly what stops overlapping content inside the group
   *  from double-darkening.
   *
   *  A buffer carrying `groupAlpha` was seeded with the backdrop (non-isolated),
   *  so the seed is removed first (ISO 32000-1 §11.4.6):
   *      C = Cn + (Cn − C0)·(α0/αgn − α0)
   *  C0/α0 is read straight back out of the parent canvas, which is untouched
   *  while the group renders — no separate backdrop copy is kept. */
  private composeGroup(buf: Canvas, use: Extract<OffscreenUse, { kind: 'group' }>): void {
    const p = new Paint(this.paint.clip, this.paint.softMask, use.alpha, use.blend);
    const ga = buf.groupAlpha;
    const par = this.canvas;
    for (let y = 0; y < buf.h; y++) {
      const dy = buf.originY + y;
      for (let x = 0; x < buf.w; x++) {
        const dx = buf.originX + x;
        const i = (y * buf.w + x) * 4;
        let sa = buf.data[i + 3];
        let sr = buf.data[i], sg = buf.data[i + 1], sb = buf.data[i + 2];
        if (ga !== undefined) {
          const agn = ga[y * buf.w + x];
          if (agn <= 0) continue;                  // the group painted nothing here
          const px = dx - par.originX, py = dy - par.originY;
          if (px >= 0 && py >= 0 && px < par.w && py < par.h) {
            const bi = (py * par.w + px) * 4;
            const a0 = par.data[bi + 3];
            // α0 = 0 → k = 0 → C = Cn, which is the isolated answer. Correct:
            // there was no backdrop to remove.
            const k = a0 / agn - a0;
            if (k !== 0) {
              sr = clamp01(sr + (sr - par.data[bi]) * k);
              sg = clamp01(sg + (sg - par.data[bi + 1]) * k);
              sb = clamp01(sb + (sb - par.data[bi + 2]) * k);
            }
          }
          sa = agn;
        }
        if (sa <= 0) continue;
        const cov = sa * p.at(dx, dy);
        if (cov <= 1e-4) continue;
        this.canvas.blend(dx, dy, [sr * 255, sg * 255, sb * 255], cov, p.blend);
      }
    }
  }

  /** Convert an offscreen buffer to a coverage mask and install it in the Paint. */
  private applySoftMask(buf: Canvas, use: Extract<OffscreenUse, { kind: 'softmask' }>): void {
    const data = new Float32Array(buf.w * buf.h);
    const bd = use.backdrop
      ? (0.3 * use.backdrop[0] + 0.59 * use.backdrop[1] + 0.11 * use.backdrop[2]) / 255
      : 0;
    for (let i = 0; i < buf.w * buf.h; i++) {
      const a = buf.data[i * 4 + 3];
      if (use.luminosity) {
        // Luminance over the backdrop where the group is not fully opaque.
        const l = 0.3 * buf.data[i * 4] + 0.59 * buf.data[i * 4 + 1] + 0.11 * buf.data[i * 4 + 2];
        data[i] = l * a + bd * (1 - a);
      } else {
        data[i] = a;                            // /S /Alpha
      }
    }
    const mask = new ClipMask(buf.originX, buf.originY, buf.originX + buf.w, buf.originY + buf.h, data);
    this.paint = new Paint(this.paint.clip, mask, this.paint.alpha, this.paint.blend);
  }

  /** The Paint for one operation, with the right constant alpha selected. */
  private paintFor(kind: 'fill' | 'stroke'): Paint {
    const a = kind === 'fill' ? this.fillAlpha : this.strokeAlpha;
    return new Paint(this.paint.clip, this.paint.softMask, a, this.paint.blend);
  }

  fill(path: Path, ctm: Matrix, color: Rgb, evenOdd: boolean): void {
    const polys = flattenPath(path, ctm);
    if (polys.length) rasterizeFill(this.canvas, polys, color, evenOdd, this.paintFor('fill'));
  }

  stroke(path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle): void {
    rasterizeStroke(this.canvas, path, ctm, color, style, this.paintFor('stroke'));
  }
  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void {
    const img = decodeImageRgba(this.doc, stream, fillColor);
    if (img) rasterizeImage(this.canvas, img, ctm, this.paintFor('fill'));
  }
  /** The cached outline source for a run's font, if it has one. */
  private glyphSourceFor(info: TextRunInfo): GlyphSource | undefined {
    if (!info.fontDict) return undefined;
    let src = this.glyphSources.get(info.fontDict);
    if (!src) { src = buildGlyphSource(this.doc, info.fontDict); this.glyphSources.set(info.fontDict, src); }
    return src;
  }

  glyphRun(info: TextRunInfo): void {
    if (this.skipGlyphs) return;
    rasterizeGlyphRun(this.canvas, info, this.glyphSourceFor(info), this.paintFor('fill'));
  }
  shading(dict: PdfDict, ctm: Matrix): void {
    rasterizeShading(this.canvas, this.doc, dict, ctm, this.paintFor('fill'));
  }
}

// ---------- Entry point ----------

/** Render one page to PNG bytes. Never throws — unsupported content degrades. */
/** What the HTML backdrop needs and `ImageOptions` deliberately does not carry,
 *  since `page.ToImage` exposes neither. */
export interface BackdropOptions {
  /** Suppress every glyph run (see `renderPageGraphicsToPng`). */
  skipGlyphs: boolean;
  /** Widget appearances to leave undrawn (see `InterpretOptions.hideWidgets`). */
  hideWidgets?: ReadonlySet<PdfDict>;
}

function renderPage(
  doc: Document, page: Page, opts: ImageOptions, o: BackdropOptions,
): Uint8Array {
  const box = opts.box ?? 'crop';
  const opaqueWhite = (opts.background ?? 'white') !== 'transparent';
  const { matrix, width: w0, height: h0 } = baseMatrix(page, box);

  let sx: number, sy: number;
  if (opts.width != null && opts.height != null) { sx = opts.width / w0; sy = opts.height / h0; }
  else if (opts.width != null) { sx = sy = opts.width / w0; }
  else if (opts.height != null) { sx = sy = opts.height / h0; }
  else { const s = opts.scale ?? 1; sx = s; sy = s; }
  if (!Number.isFinite(sx) || sx <= 0) sx = 1;
  if (!Number.isFinite(sy) || sy <= 0) sy = 1;

  const devW = Math.max(1, Math.round(w0 * sx));
  const devH = Math.max(1, Math.round(h0 * sy));
  const device = mul(matrix, [sx, 0, 0, sy, 0, 0]);

  const canvas = new Canvas(devW, devH, opaqueWhite);
  const sink = new RasterSink(doc, canvas, o.skipGlyphs);
  try {
    interpret(doc, page, device, sink,
      { annotations: opts.annotations, hideWidgets: o.hideWidgets });
  } catch {
    // Degrade: whatever composited before the failure still renders.
  }
  return canvas.toPng(opaqueWhite);
}

/** Render one page to a PNG. */
export function renderPageToPng(
  doc: Document, page: Page, opts: ImageOptions = {}): Uint8Array {
  return renderPage(doc, page, opts, { skipGlyphs: false });
}

/** The backdrop entry `htmlfixed.ts` uses for BOTH raster kinds — the one place
 *  that can hide converted form widgets from a rendered page, which is what
 *  lets `forms: true` work with `backdrop: 'page'` where Go declines. */
export function renderPageBackdropToPng(
  doc: Document, page: Page, opts: ImageOptions, o: BackdropOptions,
): Uint8Array {
  return renderPage(doc, page, opts, o);
}

/** Render one page's GRAPHICS to a PNG, with every glyph run suppressed.
 *
 *  Exists for `htmlfixed.ts`'s `backdrop: 'raster'`, which pairs this with real
 *  HTML text spans — the same reason `renderFormToRgba` below exists for
 *  `svgembed.ts`. `ImageOptions` gains nothing and `page.ToImage` is unchanged.
 *
 *  **Note:** `interpret` composites annotation `/AP` streams, so a `/FreeText`
 *  annotation's glyphs are suppressed here too — and emitted as spans by the
 *  caller, so the two layers stay consistent. That is why the suppression lives
 *  in the sink and not in a pre-pass over page content, which would miss them. */
export function renderPageGraphicsToPng(
  doc: Document, page: Page, opts: ImageOptions = {}): Uint8Array {
  return renderPage(doc, page, opts, { skipGlyphs: true });
}

/** Rasterize one Form XObject to straight-alpha sRGB RGBA, top-down, mapping
 *  its /BBox onto exactly devW x devH pixels. Unpainted area is transparent.
 *
 *  Exists for svgembed.ts's SvgRasterSink: an SVG <filter> has no PDF
 *  equivalent, so the filtered subtree is flattened to pixels and the primitive
 *  graph runs over them. Driven over a SCRATCH page -- never added to the page
 *  tree, so Save's mark-sweep drops it and the form with it.
 *
 *  Never throws: whatever composited before a failure still comes back, which
 *  is renderPageToPng's contract too. */
export function rasterizeFormRgba(
  doc: Document, form: PdfStream, devW: number, devH: number,
): ImageRgba {
  const w = Math.max(1, Math.floor(devW)), h = Math.max(1, Math.floor(devH));
  const raw = arrNums(doc, form.dict.get('BBox'));
  const bb = raw.length === 4 ? raw : [0, 0, 1, 1];
  const bx = Math.min(bb[0], bb[2]), by = Math.min(bb[1], bb[3]);
  const bw = Math.abs(bb[2] - bb[0]) || 1, bh = Math.abs(bb[3] - bb[1]) || 1;
  const sx = w / bw, sy = h / bh;

  // The scratch page is the form's BBox scaled to the raster: MediaBox
  // [0,0,w,h] means baseMatrix's flip is the only y handling needed, and the
  // `cm` below is a pure scale-and-shift in PDF's own y-up space.
  const fref = doc.allocObject(form);
  const res: PdfDict = new Map<string, PdfObject>([
    ['XObject', new Map<string, PdfObject>([['Fm0', fref]])],
  ]);
  const content = `${sx} 0 0 ${sy} ${-bx * sx} ${-by * sy} cm\n/Fm0 Do`;
  const pageDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Page')],
    ['MediaBox', [0, 0, w, h]],
    ['Resources', res],
    ['Contents', doc.allocObject({
      kind: 'stream', dict: new Map<string, PdfObject>(), raw: enc(content),
    })],
  ]);
  const page = new Page(doc, pageDict, 1);

  const canvas = new Canvas(w, h, false);
  try {
    interpret(doc, page, baseMatrix(page, 'media').matrix, new RasterSink(doc, canvas));
  } catch {
    // Degrade: whatever composited before the failure still comes back.
  }

  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h * 4; i++) {
    const v = canvas.data[i];
    out[i] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
  }
  return { w, h, data: out };
}
