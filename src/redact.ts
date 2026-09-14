// Redaction track (Phase 4). R1: glyph-level text removal under a region —
// rewrite show ops to drop covered glyphs while preserving the positioning of
// the survivors. Operates on F1's editable op-lists using F2's provenance walk.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { deflateSync } from 'node:zlib';
import { EditableContent } from './editcontent.js';
import type { ContentAddr } from './editcontent.js';
import { ContentOp, imageCutSet } from './content.js';
import { visitContent, Rect, Matrix } from './text.js';
import { PdfDict, PdfObject, PdfStream, isString, isArray, isName, isDict, isStream, name } from './types.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import { decodeImageRgba } from './raster.js';
import { coveredPixelRegion, blankPixels, encodeRgbaXObject, blankSamples, blankImageMaskSamples, encodeSamplesXObject, inlineImageToStream, PixelBox } from './imageredact.js';
import { ImageInfo } from './image.js';
import { resolveColorSpace } from './colorspace.js';
import { inflateStream } from './flate.js';
import { PageGraphics } from './graphics.js';
import { searchText } from './textedit.js';
import { removeCoveredAnnotations } from './redactannots.js';
import { sanitizeResources } from './resprune.js';
import { UnsupportedFeatureError } from './errors.js';

/** Options for {@link redactPage} / `page.Redact` / `doc.Redact`. */
export interface RedactOptions {
  /** Restrict the *search* to this page-space rectangle (`redactText` only —
   *  `redactPage` takes explicit rects and never sees this). Same centroid rule
   *  as `SearchOptions.region`. */
  region?: Rect;
  /** Fill colour of the redaction marker box as [r, g, b] in 0..1 (default black). */
  color?: [number, number, number];
  /** Also clear document metadata (/Info + XMP) when true. */
  scrubMetadata?: boolean;
  /** Keep annotations overlapping a redacted region instead of removing them.
   *  Default false. Setting it preserves their text in the saved file — and, for
   *  an annotation with an /AP, keeps drawing it over the marker box. */
  keepAnnotations?: boolean;
}

function checkRect(r: Rect): Rect {
  if (!Array.isArray(r) || r.length !== 4
      || !r.every((n) => typeof n === 'number' && Number.isFinite(n)))
    throw new TypeError('redaction rectangle must be [x0, y0, x1, y1] (4 finite numbers)');
  return r;
}

/** Remove the content under `rects` and hand the validated rects to `paint`.
 *
 *  **Invariant:** the removal → sanitize → commit ordering lives here and
 *  nowhere else. Text removal rebuilds the op list, so a caller that splits the
 *  passes lets glyph rewrites and image removals drift each other's op indices —
 *  and the failure is silent, because the page still looks redacted. Both
 *  painters (the flat marker box and the annotation overlay) share this. */
export function redactRegions(
  doc: Document, page: Page, rects: Rect[], paint: (rects: Rect[]) => void,
  keepAnnotations = false,
): void {
  const valid = rects.map(checkRect); // validate up front: no partial mutation on bad input
  const ec = new EditableContent(doc, page);
  removeRegionContent(doc, page, valid, ec); // text + images in one per-stream rebuild
  sanitizeResources(doc, page, ec);
  ec.commit();
  paint(valid);
  // Last, so the painter saw an unchanged annotation set. Nothing here touches
  // content streams, so the position is otherwise free.
  if (!keepAnnotations) removeCoveredAnnotations(doc, page, valid);
}

/** Redact every `rects` region on `page`: truly remove covered text and images,
 *  prune resources they leave orphaned, then paint an opaque marker box over
 *  each region. Text/image removal and resource pruning go through a single F1
 *  write-back; the marker is painted on top afterwards. */
export function redactPage(doc: Document, page: Page, rects: Rect[], opts: RedactOptions = {}): void {
  redactRegions(doc, page, rects, (rs) => paintRedactionBoxes(doc, page, rs, opts.color),
    opts.keepAnnotations);
  if (opts.scrubMetadata) doc.ClearMetadata();
}

/** Remove covered text glyphs and images from a page in a single per-stream
 *  rebuild, so glyph rewrites and image removals on the same stream can't drift
 *  each other's op indices. Edits go to `ec`; the caller commits. A
 *  partially-covered image is re-encoded with its covered pixels blanked; an
 *  undecodable one throws (each re-encode validates before it mutates). */
function removeRegionContent(doc: Document, page: Page, rects: Rect[], ec: EditableContent): void {
  const rs = rects.map(norm);
  if (rs.length === 0) return;

  interface PartialImage { ctm: Matrix; rects: Rect[]; }
  interface Scope {
    addr: ContentAddr; glyphs: Map<number, GlyphRec[]>;
    images: Set<number>; partial: Map<number, PartialImage>;
  }
  const streams = new Map<string, Scope>();
  const scope = (addr: ContentAddr): Scope => {
    const sk = streamKey(addr);
    let s = streams.get(sk);
    if (!s) { s = { addr, glyphs: new Map(), images: new Set(), partial: new Map() }; streams.set(sk, s); }
    return s;
  };

  visitContent(doc, page, {
    glyph: (e) => {
      const s = scope(e.addr);
      let recs = s.glyphs.get(e.addr.opIndex);
      if (!recs) { recs = []; s.glyphs.set(e.addr.opIndex, recs); }
      recs.push({
        elementIndex: e.elementIndex, byteStart: e.byteStart, byteLen: e.byteLen,
        advance: e.advance, removed: rs.some((r) => intersects(e.quad, r)),
      });
    },
    image: (e) => {
      const covering = rs.filter((r) => intersects(e.quad, r));
      if (covering.length === 0) return;
      if (covering.some((r) => contains(r, e.quad))) { scope(e.addr).images.add(e.addr.opIndex); return; }
      scope(e.addr).partial.set(e.addr.opIndex, { ctm: e.ctm, rects: covering });
    },
  });

  for (const { addr, glyphs, images, partial } of streams.values()) {
    const hasGlyphEdit = [...glyphs.values()].some((recs) => recs.some((g) => g.removed));
    if (!hasGlyphEdit && images.size === 0 && partial.size === 0) continue;

    const roResources = addr.path.length === 0 ? page.Resources : ec.xobjectResources(addr.path);
    const ownResources = () => addr.path.length === 0
      ? ensureOwnResources(doc, page)
      : (ec.xobjectResources(addr.path) ?? ensureOwnResources(doc, page));
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    const cut = imageCutSet(ops, images);
    const out: ContentOp[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (cut.has(i)) continue; // fully-covered image (and its placement group) removed
      const pi = partial.get(i);
      if (pi) {
        if (ops[i].inlineImage) { out.push(reencodeRedactedInline(doc, ops[i], pi.ctm, pi.rects)); continue; }
        const imgStream = imageStreamOf(doc, roResources, ops[i]);
        if (imgStream) {
          const newName = reencodeRedactedImage(doc, ownResources, imgStream, pi.ctm, pi.rects);
          out.push({ operator: 'Do', operands: [name(newName)] });
          continue;
        }
      }
      const recs = glyphs.get(i);
      if (recs && recs.some((g) => g.removed)) out.push(...rewriteShowOp(ops[i], recs));
      else out.push(ops[i]);
    }
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
}

/** One glyph of an affected show op, with the data needed to keep or drop it. */
interface GlyphRec {
  elementIndex: number;   // which string within a TJ array (0 for Tj/'/")
  byteStart: number;      // code-byte offset within that string
  byteLen: number;
  advance: number;        // glyph-space advance (em units); TJ shift = -1000*advance
  removed: boolean;       // its device box intersects a redaction rect
}

function norm(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}
function intersects(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
/** True when box `q` lies entirely within rect `r`. */
function contains(r: Rect, q: Rect): boolean {
  return r[0] <= q[0] && q[2] <= r[2] && r[1] <= q[1] && q[3] <= r[3];
}
function streamKey(addr: ContentAddr): string {
  return `${addr.path.join('\0')}${addr.streamIndex}`;
}

/** Remove text whose glyphs fall inside any of `rects` from a page's content,
 *  applying the edits to `ec` (the caller commits). Survivors keep their
 *  positions: removed runs collapse into equivalent TJ numeric shifts. */
export function removeGlyphsUnder(doc: Document, page: Page, rects: Rect[], ec: EditableContent): void {
  const rs = rects.map(norm);
  if (rs.length === 0) return;

  // One provenance walk: bucket every glyph by its stream, then by op index.
  const streams = new Map<string, { addr: ContentAddr; perOp: Map<number, GlyphRec[]> }>();
  visitContent(doc, page, {
    glyph: (e) => {
      const sk = streamKey(e.addr);
      let s = streams.get(sk);
      if (!s) { s = { addr: e.addr, perOp: new Map() }; streams.set(sk, s); }
      let recs = s.perOp.get(e.addr.opIndex);
      if (!recs) { recs = []; s.perOp.set(e.addr.opIndex, recs); }
      recs.push({
        elementIndex: e.elementIndex, byteStart: e.byteStart, byteLen: e.byteLen,
        advance: e.advance, removed: rs.some((r) => intersects(e.quad, r)),
      });
    },
  });

  for (const { addr, perOp } of streams.values()) {
    // Only ops with at least one covered glyph need rewriting.
    const affected = [...perOp].filter(([, recs]) => recs.some((g) => g.removed));
    if (affected.length === 0) continue;

    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    const out: ContentOp[] = [];
    for (let i = 0; i < ops.length; i++) {
      const recs = perOp.get(i);
      if (recs && recs.some((g) => g.removed)) out.push(...rewriteShowOp(ops[i], recs));
      else out.push(ops[i]);
    }
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
}

/** Remove image content (image XObject `Do` and inline `BI…EI`) whose placement
 *  box falls inside any of `rects`, applying edits to `ec` (the caller commits).
 *  A fully-covered image is dropped; a partially-covered image (XObject or inline,
 *  including inline `/ImageMask` stencils, and rotated/skewed placements) is
 *  decoded, its covered pixels blanked, and re-encoded in place (an undecodable
 *  one throws `UnsupportedFeatureError`). */
export function removeImagesUnder(doc: Document, page: Page, rects: Rect[], ec: EditableContent): void {
  const rs = rects.map(norm);
  if (rs.length === 0) return;

  // Group covered image-draw ops by their stream (full removals + partials).
  interface Scope { addr: ContentAddr; remove: Set<number>; partial: Map<number, { ctm: Matrix; rects: Rect[] }>; }
  const streams = new Map<string, Scope>();
  visitContent(doc, page, {
    image: (e) => {
      const covering = rs.filter((r) => intersects(e.quad, r));
      if (covering.length === 0) return;
      const sk = streamKey(e.addr);
      let s = streams.get(sk);
      if (!s) { s = { addr: e.addr, remove: new Set(), partial: new Map() }; streams.set(sk, s); }
      if (covering.some((r) => contains(r, e.quad))) { s.remove.add(e.addr.opIndex); return; }
      s.partial.set(e.addr.opIndex, { ctm: e.ctm, rects: covering });
    },
  });

  for (const { addr, remove, partial } of streams.values()) {
    const roResources = addr.path.length === 0 ? page.Resources : ec.xobjectResources(addr.path);
    const ownResources = () => addr.path.length === 0
      ? ensureOwnResources(doc, page)
      : (ec.xobjectResources(addr.path) ?? ensureOwnResources(doc, page));
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    const cut = imageCutSet(ops, remove);
    const out: ContentOp[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (cut.has(i)) continue;
      const pi = partial.get(i);
      if (pi) {
        if (ops[i].inlineImage) { out.push(reencodeRedactedInline(doc, ops[i], pi.ctm, pi.rects)); continue; }
        const imgStream = imageStreamOf(doc, roResources, ops[i]);
        if (imgStream) {
          const newName = reencodeRedactedImage(doc, ownResources, imgStream, pi.ctm, pi.rects);
          out.push({ operator: 'Do', operands: [name(newName)] });
          continue;
        }
      }
      out.push(ops[i]);
    }
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
}

/** Paint an opaque filled rectangle (default black) over each region as the
 *  visible redaction marker. Appended last so it sits on top of any remaining
 *  content. Independent of the removal logic.
 *
 *  In a tagged document the fill is wrapped as an /Artifact: it is decoration,
 *  and a tagged page may carry no content that is neither tagged nor
 *  artifacted. Our own UntaggedContent rule walks glyphs and images rather than
 *  path fills, so it cannot see this either way — correctness here is asserted
 *  on the content stream, not through the validator. */
export function paintRedactionBoxes(
  doc: Document, page: Page, rects: Rect[], color: [number, number, number] = [0, 0, 0],
): void {
  if (rects.length === 0) return;
  const tagged = doc.GetStructTree() !== null;
  const g = new PageGraphics(doc, page);
  if (tagged) g.BeginArtifact();
  g.setFillColor(color);
  for (const r of rects) {
    const [x0, y0, x1, y1] = norm(r);
    g.rect(x0, y0, x1 - x0, y1 - y0).fill();
  }
  if (tagged) g.EndMarkedContent();
  g.apply();
}

// Re-exported so `redact.js` stays the import path it has always been for this
// function; `resprune.ts` is the owner (see the module header there). A bare
// `export ... from` would create no local binding, and redactRegions calls it.
export { sanitizeResources };

/** Re-encode `stream` with the pixels under `rects` (device space) blanked, and
 *  register the result as a fresh copy-on-write image XObject, returning the new
 *  resource name. A rotated/skewed placement is handled by filling the mapped
 *  pixel polygon. Throws UnsupportedFeatureError when the image cannot be decoded
 *  (JPEG/JPX/JBIG2); that validation runs before `getOwned` is called, so a throw
 *  mutates nothing; `getOwned` returns the owned (copy-on-write) resource dict. */
/** Number of sample components per pixel for a colorspace we can lay out from the
 *  image dict alone, or undefined when it can't be determined reliably (a bare
 *  non-device name — e.g. a `/Resources` colorspace reference — is ambiguous
 *  here, so such images fall back to the RGBA path rather than risk a wrong
 *  stride). Indexed → 1; CMYK/ICC-CMYK/DeviceN → their colorant count. */
function sampleComponents(doc: Document, csObj: PdfObject | undefined): number | undefined {
  const r = doc.resolve(csObj);
  if (isName(r)) {
    switch (r.name) {
      case 'DeviceGray': case 'G': case 'CalGray': return 1;
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return 3;
      case 'DeviceCMYK': case 'CMYK': return 4;
      default: return undefined;
    }
  }
  if (isArray(r)) {
    return resolveColorSpace(r, (o) => doc.resolve(o), (s) => inflateStream(s as Parameters<typeof inflateStream>[0])).components;
  }
  return undefined;
}

/** If `stream` is eligible for sample-level blanking (its filter decodes to
 *  samples in the original colorspace, it has no mask/soft-mask, and its
 *  colorspace + bit-depth are laid-out-able), return `{ nc, bpc }`; else undefined
 *  (caller uses the RGBA fallback). */
function sampleRedactPlan(doc: Document, stream: PdfStream): { nc: number; bpc: number } | undefined {
  const dict = stream.dict;
  const filt = new ImageInfo(doc, '', stream).Filter ?? '';
  if (filt === 'DCTDecode' || filt === 'DCT' || filt === 'JPXDecode' || filt === 'JBIG2Decode') return undefined;
  if (doc.resolve(dict.get('ImageMask')) === true) return undefined;
  if (dict.get('SMask') !== undefined || dict.get('Mask') !== undefined) return undefined;
  const bpcV = doc.resolve(dict.get('BitsPerComponent'));
  const bpc = typeof bpcV === 'number' ? bpcV : 0;
  if (bpc !== 1 && bpc !== 2 && bpc !== 4 && bpc !== 8 && bpc !== 16) return undefined;
  const nc = sampleComponents(doc, dict.get('ColorSpace'));
  if (nc === undefined) return undefined;
  return { nc, bpc };
}

function reencodeRedactedImage(
  doc: Document, getOwned: () => PdfDict, stream: PdfStream, ctm: Matrix, rects: Rect[],
): string {
  const plan = sampleRedactPlan(doc, stream);
  let enc: { dict: PdfDict; raw: Uint8Array; smask?: { dict: PdfDict; raw: Uint8Array } };

  if (plan) {
    // Sample-preserving path: blank covered samples, keep colorspace/bit-depth.
    let samples: Uint8Array;
    try { samples = new ImageInfo(doc, '', stream).Decode(); }
    catch { throw new UnsupportedFeatureError('image codec cannot be decoded for partial redaction'); }
    const wv = doc.resolve(stream.dict.get('Width')), hv = doc.resolve(stream.dict.get('Height'));
    const w = typeof wv === 'number' ? wv : 0, h = typeof hv === 'number' ? hv : 0;
    const boxes: PixelBox[] = [];
    for (const r of rects) boxes.push(...coveredPixelRegion(ctm, w, h, r));
    blankSamples(samples, w, h, plan.nc, plan.bpc, boxes);
    enc = encodeSamplesXObject(stream.dict, samples); // validated above — mutation below
  } else {
    // Fallback: decode to RGBA and re-encode as DeviceRGB (+ SMask when non-opaque).
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    if (!img) throw new UnsupportedFeatureError('image codec cannot be decoded for partial redaction');
    const boxes: PixelBox[] = [];
    for (const r of rects) boxes.push(...coveredPixelRegion(ctm, img.w, img.h, r));
    blankPixels(img, boxes);
    enc = encodeRgbaXObject(img);
  }

  if (enc.smask) {
    const smRef = doc.allocObject({ kind: 'stream', dict: enc.smask.dict, raw: enc.smask.raw });
    enc.dict.set('SMask', smRef);
  }
  const imgRef = doc.allocObject({ kind: 'stream', dict: enc.dict, raw: enc.raw });

  const xobj = ensureOwnSubdict(doc, getOwned(), 'XObject');
  let n = 0;
  while (xobj.has(`RdImg${n}`)) n++;
  const newName = `RdImg${n}`;
  xobj.set(newName, imgRef);
  return newName;
}

/** The non-marking stencil bit for an image mask: 1 under the default /Decode
 *  [0 1] (sample 0 marks), 0 under /Decode [1 0] (sample 1 marks). */
function maskClearBit(doc: Document, dict: PdfDict): 0 | 1 {
  const d = doc.resolve(dict.get('Decode') ?? dict.get('D'));
  if (isArray(d) && d.length >= 2 && doc.resolve(d[0]) === 1 && doc.resolve(d[1]) === 0) return 0;
  return 1;
}

/** Clone an inline image dict for re-encoding as raw FlateDecode: same geometry,
 *  colorspace, bit-depth and /Decode, but drop the original filter, DecodeParms
 *  and length (no predictor), and set /F to /Fl. */
function reflatedInlineDict(src: PdfDict): PdfDict {
  const out = new Map<string, PdfObject>();
  for (const [k, v] of src) {
    if (k === 'F' || k === 'Filter' || k === 'DP' || k === 'DecodeParms' || k === 'L' || k === 'Length') continue;
    out.set(k, v);
  }
  out.set('F', name('Fl'));
  return out;
}

/** Re-encode a partially-covered inline image (`BI…EI`) in place: blank the
 *  pixels under `rects` (device space) and return a fresh `BI` op. The image
 *  stays inline — nothing in /Resources is touched. Sample-preserving when the
 *  codec/colorspace allow; otherwise decodes to RGBA and re-emits DeviceRGB, but
 *  since inline images cannot carry /SMask a non-opaque result throws. An
 *  /ImageMask stencil takes a dedicated path: its covered bits are blanked to the
 *  non-marking value and it is re-emitted as an inline ImageMask. Rotated/skewed
 *  placements fill the mapped pixel polygon; undecodable codecs throw. All
 *  validation runs before the op is built, so a throw mutates nothing. */
function reencodeRedactedInline(doc: Document, op: ContentOp, ctm: Matrix, rects: Rect[]): ContentOp {
  const inline = op.inlineImage!;
  const stream = inlineImageToStream(inline);
  const plan = sampleRedactPlan(doc, stream);

  if (plan) {
    let samples: Uint8Array;
    try { samples = new ImageInfo(doc, '', stream).Decode(); }
    catch { throw new UnsupportedFeatureError('inline image codec cannot be decoded for partial redaction'); }
    const wv = doc.resolve(stream.dict.get('Width')), hv = doc.resolve(stream.dict.get('Height'));
    const w = typeof wv === 'number' ? wv : 0, h = typeof hv === 'number' ? hv : 0;
    const boxes: PixelBox[] = [];
    for (const r of rects) boxes.push(...coveredPixelRegion(ctm, w, h, r));
    blankSamples(samples, w, h, plan.nc, plan.bpc, boxes);
    const data = new Uint8Array(deflateSync(Buffer.from(samples)));
    return { operator: 'BI', operands: [], inlineImage: { dict: reflatedInlineDict(inline.dict), data } };
  }

  // Image-mask path: a 1-bpc stencil decodes to per-pixel alpha (unrepresentable
  // inline as /SMask), so blank the covered stencil bits in place and re-emit as
  // an inline ImageMask. The non-marking sample value is 1 by default (/Decode
  // [0 1]) or 0 when /Decode is [1 0].
  if (doc.resolve(stream.dict.get('ImageMask')) === true) {
    let samples: Uint8Array;
    try { samples = new ImageInfo(doc, '', stream).Decode(); }
    catch { throw new UnsupportedFeatureError('inline image codec cannot be decoded for partial redaction'); }
    const wv = doc.resolve(stream.dict.get('Width')), hv = doc.resolve(stream.dict.get('Height'));
    const w = typeof wv === 'number' ? wv : 0, h = typeof hv === 'number' ? hv : 0;
    const boxes: PixelBox[] = [];
    for (const r of rects) boxes.push(...coveredPixelRegion(ctm, w, h, r));
    blankImageMaskSamples(samples, w, h, boxes, maskClearBit(doc, stream.dict));
    const data = new Uint8Array(deflateSync(Buffer.from(samples)));
    return { operator: 'BI', operands: [], inlineImage: { dict: reflatedInlineDict(inline.dict), data } };
  }

  // Fallback: decode to RGBA, blank, re-emit DeviceRGB. No /SMask allowed inline.
  const img = decodeImageRgba(doc, stream, [0, 0, 0]);
  if (!img) throw new UnsupportedFeatureError('inline image codec cannot be decoded for partial redaction');
  const boxes: PixelBox[] = [];
  for (const r of rects) boxes.push(...coveredPixelRegion(ctm, img.w, img.h, r));
  blankPixels(img, boxes);
  const n = img.w * img.h;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3] !== 255)
      throw new UnsupportedFeatureError('inline image with transparency cannot be partially redacted');
    rgb[i * 3] = img.data[i * 4]; rgb[i * 3 + 1] = img.data[i * 4 + 1]; rgb[i * 3 + 2] = img.data[i * 4 + 2];
  }
  const data = new Uint8Array(deflateSync(Buffer.from(rgb)));
  const dict = new Map<string, PdfObject>([
    ['W', img.w], ['H', img.h], ['CS', name('RGB')], ['BPC', 8], ['F', name('Fl')],
  ]);
  return { operator: 'BI', operands: [], inlineImage: { dict, data } };
}

/** Resolve the image XObject stream a `Do` op draws, given (read-only) resources. */
function imageStreamOf(doc: Document, resources: PdfDict | undefined, op: ContentOp): PdfStream | undefined {
  const nm = op.operands[0];
  if (!resources || !isName(nm)) return undefined;
  const xobj = doc.resolve(resources.get('XObject'));
  if (!isDict(xobj)) return undefined;
  const s = doc.resolve(xobj.get(nm.name));
  return isStream(s) ? s : undefined;
}

/** Rewrite a single show op (Tj/'/"/TJ) into an equivalent op sequence with the
 *  covered glyphs replaced by numeric advance shifts. */
function rewriteShowOp(op: ContentOp, glyphs: GlyphRec[]): ContentOp[] {
  switch (op.operator) {
    case 'Tj': return [tjFromString(op.operands[0], glyphs, 0)];
    case "'":
      return [{ operator: 'T*', operands: [] }, tjFromString(op.operands[0], glyphs, 0)];
    case '"':
      return [
        { operator: 'Tw', operands: [op.operands[0]] },
        { operator: 'Tc', operands: [op.operands[1]] },
        { operator: 'T*', operands: [] },
        tjFromString(op.operands[2], glyphs, 0),
      ];
    case 'TJ': return [tjFromArray(op.operands[0], glyphs)];
    default: return [op]; // not a show op; leave untouched
  }
}

/** Build a TJ op from a single show string, dropping covered glyphs. */
function tjFromString(strObj: PdfObject, glyphs: GlyphRec[], elementIndex: number): ContentOp {
  const arr: PdfObject[] = [];
  appendStringElement(arr, strObj, glyphs, elementIndex);
  return { operator: 'TJ', operands: [arr] };
}

/** Rebuild a TJ array: keep original numeric kerns, split string elements. */
function tjFromArray(arrObj: PdfObject, glyphs: GlyphRec[]): ContentOp {
  const out: PdfObject[] = [];
  if (isArray(arrObj)) {
    arrObj.forEach((el, idx) => {
      if (isString(el)) appendStringElement(out, el, glyphs, idx);
      else if (typeof el === 'number') out.push(el); // preserve original kerning
    });
  }
  return { operator: 'TJ', operands: [out] };
}

/** Append one show string to the TJ output, emitting survivor byte-runs as
 *  strings and covered runs as numeric shifts equal to their advance. */
function appendStringElement(out: PdfObject[], strObj: PdfObject, glyphs: GlyphRec[], elementIndex: number): void {
  if (!isString(strObj)) return;
  const bytes = strObj.bytes;
  const mine = glyphs
    .filter((g) => g.elementIndex === elementIndex)
    .sort((a, b) => a.byteStart - b.byteStart);

  let survivor: number[] = [];
  let pendingShift = 0; // accumulated -1000*advance of a covered run
  const flushSurvivor = () => {
    if (survivor.length) { out.push({ kind: 'string', bytes: Uint8Array.from(survivor) }); survivor = []; }
  };
  const flushShift = () => {
    if (pendingShift !== 0) { out.push(pendingShift); pendingShift = 0; }
  };

  if (mine.length === 0) { // no decoded glyphs (e.g. no font): keep verbatim
    out.push({ kind: 'string', bytes });
    return;
  }
  for (const g of mine) {
    if (g.removed) {
      flushSurvivor();
      pendingShift += -1000 * g.advance;
    } else {
      flushShift();
      for (let i = g.byteStart; i < g.byteStart + g.byteLen; i++) survivor.push(bytes[i]);
    }
  }
  flushSurvivor();
  flushShift(); // trailing covered run still advances the pen for following ops
}

/** Redact every occurrence of `find` (a literal string or RegExp) on `page`:
 *  search the page's assembled text, then remove and mark every matched region
 *  in a single {@link redactPage} pass (honoring `opts.color` /
 *  `opts.scrubMetadata`). Returns the number of occurrences redacted; a run with
 *  no matches is a no-op that returns 0 (no content rewrite, no metadata scrub). */
export function redactText(
  doc: Document, page: Page, find: string | RegExp, opts: RedactOptions = {},
): number {
  // `region` scopes the search only. Destructured out rather than forwarded, so
  // it cannot reach redactPage — which takes explicit rects and would have
  // nothing to do with it, but would silently accept the key.
  const { region, ...pageOpts } = opts;
  // Redaction acts on what the file CONTAINS, never on what a configuration
  // happens to show: redacting only the visible occurrences leaves the secret
  // in the bytes while reporting success.
  const matches = searchText(doc, page, find, { region, includeHidden: true });
  if (matches.length === 0) return 0;
  const rects: Rect[] = matches.flatMap((m) => m.quads);
  redactPage(doc, page, rects, pageOpts);
  return matches.length;
}
