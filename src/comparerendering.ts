/**
 * Graphical comparison of two documents (`aq4a.5`), behind
 * `Document.CompareRendering`: render each page pair, diff the pixels, report
 * the changed regions in page space and, on request, a difference image.
 *
 * It sees what `CompareText` cannot — a recoloured heading, a moved image, a
 * changed line — and cannot see what that one can: it has no idea WHAT
 * changed, only where. The two are complements.
 *
 * Pixels come from `raster.ts`'s `renderPageRgb`, which hands back the
 * page-to-pixel matrix the render itself used; a region goes back to page
 * space through that matrix's inverse, so `/Rotate`, the CropBox origin and
 * the resolution need no case here. Imports `Document` as a TYPE only.
 */
import type { Document } from './document.js';
import type { Page } from './page.js';
import { renderPageRgb } from './raster.js';
import { diffPixels, changedRegions, diffImage, type RgbImage, type PixelRegion } from './pixeldiff.js';
import { encodePng } from './pngencode.js';
import { apply, invert, type Matrix, type Rect } from './text.js';

export interface RenderingCompareOptions {
  /** Render resolution in dots per inch. Default 72, one pixel per point. */
  dpi?: number;
  /** How far a channel may differ (0..255) before a pixel counts as changed.
   *  Default 0: any difference. Raise it to ignore anti-aliasing noise between
   *  documents produced by different tools. */
  tolerance?: number;
  /** Changes about this many points apart are reported as one region. Default
   *  6; 0 reports every connected group of changed pixels on its own. */
  mergeDistance?: number;
  /** Also return a difference image per page: the second document's page
   *  faded, changed pixels in red, as PNG. Default false. */
  image?: boolean;
  /** Render annotation and form-field appearances. Default true. */
  annotations?: boolean;
}

export interface PageRenderingComparison {
  /** 1-based page in the first document; undefined when only the second has it. */
  oldPage?: number;
  newPage?: number;
  /** The compared grid in pixels: the larger of the two renders. */
  width: number;
  height: number;
  changedPixels: number;
  totalPixels: number;
  /** changedPixels / totalPixels. */
  ratio: number;
  /** Changed regions in the PAGE space of the second document's page (the
   *  first's, when only it has the page), top to bottom then left to right. */
  regions: Rect[];
  /** The difference image as PNG, when `image` was asked for. */
  image?: Uint8Array;
}

export interface RenderingComparison {
  pages: PageRenderingComparison[];
  changedPixels: number;
  totalPixels: number;
  ratio: number;
  /** True when no pixel changed on any page. */
  identical: boolean;
}

/** Compare how `a` and `b` render, page by page. */
export function compareRendering(a: Document, b: Document, opts: RenderingCompareOptions = {}): RenderingComparison {
  if (!b || typeof b !== 'object' || !Array.isArray((b as Document).Pages)) {
    throw new TypeError('CompareRendering: other must be a Document');
  }
  const dpi = opts.dpi ?? 72;
  if (typeof dpi !== 'number' || !Number.isFinite(dpi) || dpi <= 0) throw new RangeError('CompareRendering: dpi must be a positive number');
  const tolerance = opts.tolerance ?? 0;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new RangeError('CompareRendering: tolerance must be an integer 0..255');
  const merge = opts.mergeDistance ?? 6;
  if (typeof merge !== 'number' || !Number.isFinite(merge) || merge < 0) throw new RangeError('CompareRendering: mergeDistance must be a finite number >= 0');
  const n = Math.max(a.Pages.length, b.Pages.length);
  if (n === 0) throw new RangeError('CompareRendering: neither document has a page');

  const scale = dpi / 72;
  const cell = Math.max(1, Math.round(merge * scale));
  const render = (d: Document, p: Page | undefined) =>
    p ? renderPageRgb(d, p, scale, opts.annotations !== false) : undefined;

  const pages: PageRenderingComparison[] = [];
  for (let i = 0; i < n; i++) {
    const pa = a.Pages[i], pb = b.Pages[i];
    const ra = render(a, pa), rb = render(b, pb);
    const d = diffPixels(ra, rb, tolerance);
    const ref = (rb ?? ra)!;
    const toPage = invert(ref.device);
    const page: PageRenderingComparison = {
      oldPage: pa ? i + 1 : undefined,
      newPage: pb ? i + 1 : undefined,
      width: d.width, height: d.height,
      changedPixels: d.changed,
      totalPixels: d.width * d.height,
      ratio: d.width * d.height === 0 ? 0 : d.changed / (d.width * d.height),
      regions: changedRegions(d, cell).map((r) => pageRect(r, toPage)),
    };
    if (opts.image) page.image = encodePng(d.width, d.height, diffImage(rb ?? ra as RgbImage, d), 'rgb');
    pages.push(page);
  }
  const changedPixels = pages.reduce((s, p) => s + p.changedPixels, 0);
  const totalPixels = pages.reduce((s, p) => s + p.totalPixels, 0);
  return {
    pages, changedPixels, totalPixels,
    ratio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    identical: changedPixels === 0,
  };
}

/** A pixel box back in page space: the inverse device matrix applied to its
 *  four corners, then their bounds — a quarter turn swaps the axes. */
function pageRect(r: PixelRegion, toPage: Matrix): Rect {
  const pts = [apply(toPage, r.x0, r.y0), apply(toPage, r.x1, r.y0), apply(toPage, r.x0, r.y1), apply(toPage, r.x1, r.y1)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
