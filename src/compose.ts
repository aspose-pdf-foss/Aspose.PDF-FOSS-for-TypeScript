// Page composition (Phase 5). C0: import a page (from this or another document)
// into a target document as a shareable Form XObject — the foundation the
// overlay/underlay, N-up, and stamping APIs build on. Append-only consumers.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfRef, isStream, name } from './types.js';
import { cloneShallow, rewriteRefs } from './extractor.js';
import { mul, placementMatrix, containMatrix, IDENTITY, type Matrix } from './text.js';
import {
  ensureOwnResources, ensureOwnSubdict, freshKey, registerExtGState,
  appendContent, prependContent, transformContent, num,
} from './pagecontent.js';
import { enc } from './serialize.js';

/** Deep-copy the object graph reachable from `root` (resolved in `srcDoc`) into
 *  `target`, returning a copy of `root` whose refs point at the freshly
 *  allocated target objects. Cycle-safe; allocates one target object per
 *  distinct source object and never mutates the source. */
function importGraphInto(target: Document, srcDoc: Document, root: PdfObject): PdfObject {
  const seen = new Map<number, PdfRef>(); // source obj num -> target ref
  const visit = (r: PdfRef): PdfRef => {
    const existing = seen.get(r.num);
    if (existing) return existing;
    const clone = cloneShallow(srcDoc.getObject(r.num));
    const newRef = target.allocObject(clone);
    seen.set(r.num, newRef);
    rewriteRefs(clone, visit); // recurse into the stored clone (mutates the copy)
    return newRef;
  };
  const rootClone = cloneShallow(root);
  rewriteRefs(rootClone, visit);
  return rootClone;
}

/** Matrix mapping the source CropBox (with /Rotate applied) into an upright
 *  form-space box anchored at the origin. /BBox stays = CropBox; consumers
 *  transform the BBox by this matrix to position the placement. */
function importMatrix(rotate: number, box: number[]): Matrix {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0;
  const t: Matrix = [1, 0, 0, 1, -x0, -y0]; // CropBox origin -> (0,0)
  let rot: Matrix;
  switch (rotate) {
    case 90:  rot = [0, 1, -1, 0, h, 0]; break;
    case 180: rot = [-1, 0, 0, -1, w, h]; break;
    case 270: rot = [0, -1, 1, 0, 0, w]; break;
    default:  rot = [1, 0, 0, 1, 0, 0];
  }
  return mul(t, rot); // t then rot
}

/** @internal Import `src` (a page from this or another Document) into `target`
 *  as a shareable Form XObject and return its new ref in `target`. The page's
 *  decoded content becomes the stream body, its resources are deep-copied,
 *  /BBox is the source CropBox, and /Matrix orients the content per /Rotate.
 *  The source document is left untouched. */
export function importPageAsXObject(target: Document, src: Page): PdfRef {
  const srcDoc = src.Document;
  const body = src.Contents; // decoded, concatenated bytes
  const srcRes = src.Resources;
  const resources: PdfObject = srcRes
    ? importGraphInto(target, srcDoc, srcRes)
    : new Map<string, PdfObject>();
  const box = src.CropBox; // falls back to MediaBox
  const matrix = importMatrix(src.Rotate, box);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box[0], box[1], box[2], box[3]]],
    ['Matrix', [...matrix]],
    ['Resources', resources],
  ]);
  return target.allocObject({ kind: 'stream', dict, raw: body });
}

/** @internal Import `src` into `target` and place it on `sheet`, uniformly
 *  scaled to fit and centered within `cell` ([x0, y0, x1, y1]), preserving aspect
 *  ratio. Each call registers a fresh Fm key and appends its own q/Q body, so
 *  many cells compose on one sheet. Used by N-up imposition. */
export function placeFitted(
  target: Document, sheet: Page, src: Page, cell: [number, number, number, number],
): void {
  const ref = importPageAsXObject(target, src);
  const xobj = target.resolve(ref);
  if (!isStream(xobj)) return; // unreachable: import always returns a stream
  const bbox = xobj.dict.get('BBox') as number[];
  const m = xobj.dict.get('Matrix') as Matrix;
  const place = containMatrix(bbox, m, cell);
  if (place === undefined) return; // degenerate source: nothing to draw

  const res = ensureOwnResources(target, sheet);
  const xobjs = ensureOwnSubdict(target, res, 'XObject');
  const key = freshKey(xobjs, 'Fm');
  xobjs.set(key, ref);
  appendContent(target, sheet, enc(`q\n${place.map(num).join(' ')} cm\n/${key} Do\nQ`));
}

export interface StampWithOptions {
  /** 'overlay' draws on top of existing content, 'underlay' behind it. Default 'overlay'. */
  mode?: 'overlay' | 'underlay';
  /** Target box [x0, y0, x1, y1] the source is fitted into; default = page CropBox. */
  rect?: [number, number, number, number];
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1 (opaque). */
  opacity?: number;
  /** Extra clockwise rotation of the placed content, in degrees. Default 0. */
  rotate?: 0 | 90 | 180 | 270;
}

/** Clockwise rotation matrix about the origin (PDF /Rotate convention). */
function rotateMatrix(deg: number): Matrix {
  switch (deg) {
    case 90:  return [0, -1, 1, 0, 0, 0];
    case 180: return [-1, 0, 0, -1, 0, 0];
    case 270: return [0, 1, -1, 0, 0, 0];
    default:  return [...IDENTITY];
  }
}

/** Validate `rect`/`rotate` placement options (shared by StampWith and Overlay). */
function validatePlacement(rect: number[] | undefined, rotate: number): void {
  if (rect !== undefined &&
      (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n))))
    throw new TypeError('rect must be [x0, y0, x1, y1] (4 finite numbers)');
  if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270)
    throw new TypeError('rotate must be 0, 90, 180, or 270');
}

interface Placement {
  ref: PdfRef;
  rect?: [number, number, number, number];
  opacity?: number;
  rotate: number;     // already defaulted/validated
  underlay: boolean;
}

/** Place an already-imported Form-XObject `ref` onto `page`: register it under
 *  the page's COW /Resources/XObject (fresh Fm key) and splice a positioned
 *  `q [gs] <cm> /Fm Do Q` body, fitting the XObject /BBox onto `rect` (default
 *  the page's CropBox) through any extra rotation. Reusable across many pages
 *  for the same shared `ref`. */
function placeXObject(doc: Document, page: Page, p: Placement): void {
  const xobj = doc.resolve(p.ref);
  if (!isStream(xobj)) return; // unreachable: import always returns a stream
  const bbox = (xobj.dict.get('BBox') as number[]);
  const m = (xobj.dict.get('Matrix') as Matrix);

  // Map the (extra-rotated) XObject BBox onto the target box. The `Do` applies
  // the XObject's own /Matrix, so the emitted cm is rotate · placement.
  const r = rotateMatrix(p.rotate);
  const place = placementMatrix(bbox, mul(m, r), p.rect ?? page.CropBox);
  if (place === undefined) return; // degenerate (zero-area) source: nothing to draw
  const cm = mul(r, place);

  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Fm');
  xobjs.set(key, p.ref);

  const gsKey = p.opacity !== undefined && p.opacity < 1
    ? registerExtGState(doc, page, p.opacity) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += `${cm.map(num).join(' ')} cm\n/${key} Do\nQ`;
  const body = enc(s);
  if (p.underlay) prependContent(doc, page, body);
  else appendContent(doc, page, body);
}

/** Place `src` (a page from this or another Document) onto `page` as a shared
 *  Form XObject, fitted to `opts.rect` (default the page's CropBox) and drawn as
 *  an overlay (default) or underlay. The source document is left untouched. */
export function stampWith(
  doc: Document, page: Page, src: Page, opts: StampWithOptions = {},
): void {
  const rotate = opts.rotate ?? 0;
  validatePlacement(opts.rect, rotate);
  const ref = importPageAsXObject(doc, src);
  placeXObject(doc, page, {
    ref, rect: opts.rect, opacity: opts.opacity, rotate,
    underlay: opts.mode === 'underlay',
  });
}

export interface OverlayOptions {
  /** 1-based target pages; default = every page. */
  pages?: number[];
  /** Draw behind existing content instead of on top. Default false (overlay). */
  underlay?: boolean;
  /** Target box [x0, y0, x1, y1] the source is fitted into; default = page CropBox. */
  rect?: [number, number, number, number];
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1 (opaque). */
  opacity?: number;
  /** Extra clockwise rotation of the placed content, in degrees. Default 0. */
  rotate?: 0 | 90 | 180 | 270;
}

/** Stamp a single source page onto many target pages of `doc`. The source (a
 *  `Page`, or a `Document` whose first page is used) is imported **once** and the
 *  one shared Form XObject is placed on each selected page. Convenience over
 *  `StampWith` for letterheads / watermarks / backgrounds; a cross-document
 *  source is left untouched. */
export function overlay(
  doc: Document, src: Page | DocumentLike, opts: OverlayOptions = {},
): void {
  const rotate = opts.rotate ?? 0;
  validatePlacement(opts.rect, rotate);

  const srcPage = 'Pages' in src ? src.Pages[0] : src;
  if (srcPage === undefined) throw new TypeError('Overlay: source document has no pages');

  const targets = doc.Pages;
  const selected = opts.pages ?? targets.map((p) => p.Number);
  for (const n of selected) {
    if (!Number.isInteger(n) || n < 1 || n > targets.length)
      throw new RangeError(`Overlay: page ${n} out of range (1..${targets.length})`);
  }

  const ref = importPageAsXObject(doc, srcPage); // import once, share across pages
  const underlay = opts.underlay === true;
  for (const n of selected) {
    placeXObject(doc, targets[n - 1], {
      ref, rect: opts.rect, opacity: opts.opacity, rotate, underlay,
    });
  }
}

/** A resolved N-up cell frame. */
export interface NUpBorder {
  width: number;
  color: [number, number, number];
}

export interface NUpOptions {
  /** Output sheet size [w, h]; default = source page size * grid (plus margins/gutters). */
  pageSize?: [number, number];
  /** Outer margin in points around the whole grid. Default 0. */
  margin?: number;
  /** Spacing in points between cells. Default 0. */
  gutter?: number;
  /** Cell fill order across a sheet. Default 'row' (left-to-right, top-to-bottom). */
  order?: 'row' | 'column';
  /** Frame each imposed cell — the usual way a proof sheet is made readable.
   *  `true` is a hairline black rule; pass an object for width/colour. Default
   *  false, which leaves output byte-identical to a call without the option.
   *  Only cells that actually received a page are framed. */
  drawBorder?: boolean | Partial<NUpBorder>;
}

/** Validate and resolve {@link NUpOptions.drawBorder}; undefined when no frame
 *  is wanted. Defaults to a 0.5pt black hairline, which is what a proof sheet
 *  wants: heavy enough to read, light enough not to be mistaken for content. */
export function resolveNUpBorder(v: NUpOptions['drawBorder']): NUpBorder | undefined {
  if (v === undefined || v === false) return undefined;
  if (v === true) return { width: 0.5, color: [0, 0, 0] };
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new TypeError('NUp: drawBorder must be a boolean or a { width, color } object');
  const width = v.width ?? 0.5;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0)
    throw new TypeError('NUp: drawBorder width must be a positive finite number');
  const color = v.color ?? [0, 0, 0];
  if (!Array.isArray(color) || color.length !== 3 ||
      !color.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('NUp: drawBorder color must be [r, g, b] with each component in 0..1');
  return { width, color: [color[0], color[1], color[2]] };
}

/** Minimal shape of `Document` used to discriminate a Page from a Document arg
 *  without a runtime import (avoids a compose↔document cycle). */
interface DocumentLike { Pages: Page[]; }

export interface ResizeOptions {
  /** Scale existing content to fill the new box (old CropBox → box). Default false. */
  scaleContent?: boolean;
}

function checkRect(box: number[]): void {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => Number.isFinite(n)))
    throw new TypeError('box must be [x0, y0, x1, y1] (4 finite numbers)');
}

/** Set `page` MediaBox and CropBox to `box`. With `scaleContent`, wrap existing
 *  content in a `cm` mapping the old CropBox onto `box` (anisotropic) so it fills
 *  the new box; otherwise content keeps its coordinates. Bleed/Trim/Art are left
 *  untouched (callers manage them). Throws TypeError for a malformed box. */
export function resizePage(doc: Document, page: Page, box: number[], opts: ResizeOptions = {}): void {
  checkRect(box);
  const [ox0, oy0, ox1, oy1] = page.CropBox; // snapshot before mutating boxes
  page.MediaBox = box;
  page.CropBox = box;
  if (opts.scaleContent) {
    const ow = ox1 - ox0, oh = oy1 - oy0;
    const [nx0, ny0, nx1, ny1] = box;
    if (ow !== 0 && oh !== 0) {
      const sx = (nx1 - nx0) / ow, sy = (ny1 - ny0) / oh;
      transformContent(doc, page, [sx, 0, 0, sy, nx0 - sx * ox0, ny0 - sy * oy0]);
    }
  }
}

/** Uniformly scale `page` by `factor > 0`: multiply every present boundary box
 *  and wrap content in `factor 0 0 factor 0 0 cm`. Absent optional boxes
 *  (Bleed/Trim/Art) are not materialized. Throws RangeError for a non-finite or
 *  non-positive factor. */
export function scalePage(doc: Document, page: Page, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0)
    throw new RangeError('Scale: factor must be a finite number > 0');
  const sb = (b: number[]): number[] => b.map((v) => v * factor);
  // Snapshot every box BEFORE mutating, so CropBox's MediaBox fallback can't
  // read an already-scaled MediaBox (which would double-scale it).
  const media = page.MediaBox, crop = page.CropBox;
  const bleed = page.Dict.has('BleedBox') ? page.BleedBox : undefined;
  const trim = page.Dict.has('TrimBox') ? page.TrimBox : undefined;
  const art = page.Dict.has('ArtBox') ? page.ArtBox : undefined;
  page.MediaBox = sb(media);
  page.CropBox = sb(crop);
  if (bleed) page.BleedBox = sb(bleed);
  if (trim) page.TrimBox = sb(trim);
  if (art) page.ArtBox = sb(art);
  transformContent(doc, page, [factor, 0, 0, factor, 0, 0]);
}
