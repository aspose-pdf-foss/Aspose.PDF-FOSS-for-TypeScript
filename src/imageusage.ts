import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfStream, isDict, isName, isStream, isArray } from './types.js';
import { parseContentStream, ContentOp } from './content.js';
import { contentStreamBytes, Matrix, mul, IDENTITY } from './text.js';
import { decodeStream } from './filters.js';

/** How large an image is actually painted, and whether that is trustworthy. */
export interface ImageUsage {
  /** Highest effective DPI over every placement. 0 when never drawn. */
  maxDpi: number;
  /** False when a placement could not be measured — the image must be skipped. */
  complete: boolean;
  reason?: string;
  /** Resource key of the first placement seen; diagnostic only. */
  name?: string;
}

export type ImageUsageMap = Map<PdfStream, ImageUsage>;

const MAX_XOBJECT_DEPTH = 8;

interface Ctx { doc: Document; usage: ImageUsageMap }

function nameOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
}

function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
}

/** Resolve an array-valued key to plain numbers (indirect elements included). */
function numsOf(doc: Document, o: PdfObject | undefined): number[] {
  const r = doc.resolve(o);
  if (!isArray(r)) return [];
  const out: number[] = [];
  for (const e of r) { const v = doc.resolve(e); if (typeof v === 'number') out.push(v); }
  return out;
}

const operandNums = (ops: readonly PdfObject[]): number[] =>
  ops.filter((x): x is number => typeof x === 'number');

function numKey(doc: Document, d: PdfDict, k: string): number {
  const v = doc.resolve(d.get(k));
  return typeof v === 'number' ? v : 0;
}

/**
 * Effective DPI of an image painted into the unit square by `ctm`.
 *
 * The unit square's edges map to the vectors (a,b) and (c,d), so their lengths
 * are the device extents — hypot, not `a`/`d` alone, so rotated and skewed
 * placements measure their true size rather than reading 0.
 *
 * Returns the max of the two axes, which is conservative: it keeps more pixels
 * than the average would, and the caller scales both axes uniformly to preserve
 * aspect ratio. undefined for a degenerate (zero-extent) placement.
 */
function dpiOf(ctm: Matrix, w: number, h: number): number | undefined {
  const ex = Math.hypot(ctm[0], ctm[1]);
  const ey = Math.hypot(ctm[2], ctm[3]);
  if (!(ex > 1e-9) || !(ey > 1e-9)) return undefined;
  return Math.max((w * 72) / ex, (h * 72) / ey);
}

function entry(ctx: Ctx, s: PdfStream, key?: string): ImageUsage {
  let u = ctx.usage.get(s);
  if (!u) { u = { maxDpi: 0, complete: true, name: key }; ctx.usage.set(s, u); }
  return u;
}

function record(ctx: Ctx, s: PdfStream, key: string, ctm: Matrix): void {
  const u = entry(ctx, s, key);
  const w = numKey(ctx.doc, s.dict, 'Width');
  const h = numKey(ctx.doc, s.dict, 'Height');
  const dpi = w > 0 && h > 0 ? dpiOf(ctm, w, h) : undefined;
  if (dpi === undefined) {
    u.complete = false;
    u.reason = 'placement could not be measured';
    return;
  }
  u.maxDpi = Math.max(u.maxDpi, dpi);
}

function markIncomplete(ctx: Ctx, s: PdfStream, key: string | undefined, reason: string): void {
  const u = entry(ctx, s, key);
  u.complete = false;
  u.reason = reason;
}

/** Mark every image in `resources` unusable — a broken stream could have drawn
 *  any of them, so none of their placements are accounted for. */
function markScopeIncomplete(ctx: Ctx, resources: PdfDict | undefined, reason: string): void {
  const xo = resolveDict(ctx.doc, resources?.get('XObject'));
  if (!xo) return;
  for (const [k, v] of xo) {
    const s = ctx.doc.resolve(v);
    if (isStream(s) && nameOf(ctx.doc, s.dict.get('Subtype')) === 'Image') {
      markIncomplete(ctx, s, k, reason);
    }
  }
}

/**
 * Walk one graphics-state scope.
 *
 * `measurable` is false for scopes whose device CTM this scan does not model
 * (Type3 glyph procedures, where the real CTM is the font matrix times the text
 * matrix times the CTM at show time). Images drawn there are marked incomplete
 * rather than measured: the alternative is measuring an image from its *page*
 * placement while a Type3 glyph shows it larger, and downsampling below what
 * that glyph needs.
 */
function walkOps(
  ctx: Ctx, ops: ContentOp[], resources: PdfDict | undefined,
  baseCtm: Matrix, depth: number, seen: Set<PdfDict>, measurable: boolean,
): void {
  const xobjects = resolveDict(ctx.doc, resources?.get('XObject'));
  let ctm = baseCtm;
  const stack: Matrix[] = [];

  for (const op of ops) {
    switch (op.operator) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? baseCtm; break;
      case 'cm': {
        const m = operandNums(op.operands);
        if (m.length === 6) ctm = mul(m as Matrix, ctm);
        break;
      }
      case 'Do': {
        const key = op.operands[0];
        if (!isName(key) || !xobjects) break;
        const xo = ctx.doc.resolve(xobjects.get(key.name));
        if (!isStream(xo)) break;
        const sub = nameOf(ctx.doc, xo.dict.get('Subtype'));
        if (sub === 'Image') {
          if (measurable) record(ctx, xo, key.name, ctm);
          else markIncomplete(ctx, xo, key.name, 'drawn from a scope whose CTM the scan does not model');
          break;
        }
        if (sub === 'Form') {
          const m = numsOf(ctx.doc, xo.dict.get('Matrix'));
          const childCtm = m.length === 6 ? mul(m as Matrix, ctm) : ctm;
          walkStream(
            ctx, xo, resolveDict(ctx.doc, xo.dict.get('Resources')) ?? resources,
            childCtm, depth + 1, seen, measurable,
          );
        }
        break;
      }
      default: break;
    }
  }
}

/**
 * Parse and walk one content stream.
 *
 * `seen` is added to on entry and **removed on exit** — unlike glyphusage.ts,
 * which adds permanently. That difference is load-bearing: glyphusage only needs
 * to know *whether* a font is used, so visiting a Form XObject once suffices,
 * but a Form drawn twice at different scales yields two different DPIs and both
 * must be measured. Add/remove still breaks cycles (a stream cannot contain
 * itself), which is all the guard is for.
 */
function walkStream(
  ctx: Ctx, stream: PdfStream, resources: PdfDict | undefined,
  baseCtm: Matrix, depth: number, seen: Set<PdfDict>, measurable: boolean,
): void {
  if (depth > MAX_XOBJECT_DEPTH) {
    markScopeIncomplete(ctx, resources, 'XObject nesting too deep');
    return;
  }
  if (seen.has(stream.dict)) return;
  seen.add(stream.dict);
  try {
    let ops: ContentOp[];
    try { ops = parseContentStream(decodeStream(stream)); }
    catch { markScopeIncomplete(ctx, resources, 'content stream failed to parse'); return; }
    walkOps(ctx, ops, resources, baseCtm, depth, seen, measurable);
  } finally {
    seen.delete(stream.dict);
  }
}

function walkPage(ctx: Ctx, page: Page): void {
  const resources = page.Resources;
  const seen = new Set<PdfDict>();
  let streams: Uint8Array[];
  try { streams = contentStreamBytes(ctx.doc, page); }
  catch { markScopeIncomplete(ctx, resources, 'page contents failed to decode'); return; }

  // PDF 32000 7.8.2: a /Contents array is *one* stream divided at token
  // boundaries. Concatenating before parsing is what the spec describes, and it
  // keeps a `q` in one part paired with its `Q` in the next.
  const joined = new Uint8Array(streams.reduce((n, s) => n + s.length + 1, 0));
  let off = 0;
  for (const s of streams) { joined.set(s, off); off += s.length; joined[off++] = 0x0a; }

  let ops: ContentOp[];
  try { ops = parseContentStream(joined); }
  catch { markScopeIncomplete(ctx, resources, 'content stream failed to parse'); return; }
  walkOps(ctx, ops, resources, IDENTITY, 0, seen, true);

  walkAnnotations(ctx, page, seen);
  walkPatterns(ctx, resources, seen);
  walkType3(ctx, resolveDict(ctx.doc, resources?.get('Font')), seen);
}

/**
 * The CTM mapping an annotation's /AP stream into its /Rect (PDF 32000 12.5.5):
 * the /BBox corners are transformed by /Matrix, and the transformed bounding box
 * is scaled and translated to fit /Rect.
 */
function apCtm(doc: Document, annot: PdfDict, ap: PdfStream): Matrix {
  const rect = numsOf(doc, annot.get('Rect'));
  const bbox = numsOf(doc, ap.dict.get('BBox'));
  const m = numsOf(doc, ap.dict.get('Matrix'));
  const matrix: Matrix = m.length === 6 ? (m as Matrix) : IDENTITY;
  if (rect.length !== 4 || bbox.length !== 4) return matrix;

  const rx0 = Math.min(rect[0], rect[2]), ry0 = Math.min(rect[1], rect[3]);
  const rx1 = Math.max(rect[0], rect[2]), ry1 = Math.max(rect[1], rect[3]);
  const corners: [number, number][] = [
    [bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]],
  ];
  const xs: number[] = [], ys: number[] = [];
  for (const [x, y] of corners) {
    xs.push(matrix[0] * x + matrix[2] * y + matrix[4]);
    ys.push(matrix[1] * x + matrix[3] * y + matrix[5]);
  }
  const bx0 = Math.min(...xs), by0 = Math.min(...ys);
  const bw = Math.max(...xs) - bx0, bh = Math.max(...ys) - by0;
  const sx = bw > 1e-9 ? (rx1 - rx0) / bw : 1;
  const sy = bh > 1e-9 ? (ry1 - ry0) / bh : 1;
  const fit: Matrix = [sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy];
  return mul(matrix, fit);
}

/** Every /AP appearance stream on a page's annotations: /N, /D, /R, including
 *  the sub-dictionary form (/N << /On 5 0 R /Off 6 0 R >>). */
function walkAnnotations(ctx: Ctx, page: Page, seen: Set<PdfDict>): void {
  const annots = ctx.doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const a of annots) {
    const annot = resolveDict(ctx.doc, a);
    const ap = annot ? resolveDict(ctx.doc, annot.get('AP')) : undefined;
    if (!annot || !ap) continue;
    for (const key of ['N', 'D', 'R']) {
      const e = ctx.doc.resolve(ap.get(key));
      const streams = isStream(e) ? [e]
        : isDict(e) ? [...e.values()].map((v) => ctx.doc.resolve(v)).filter(isStream)
        : [];
      for (const s of streams) {
        walkStream(ctx, s, resolveDict(ctx.doc, s.dict.get('Resources')),
          apCtm(ctx.doc, annot, s), 0, seen, true);
      }
    }
  }
}

/** Every tiling pattern (PatternType 1). PDF 32000 8.7.3.1: a pattern's /Matrix
 *  maps pattern space to the *default* space of its parent content stream, not
 *  to the CTM at fill time — so /Matrix alone is the base CTM and the placement
 *  is fully measurable. */
function walkPatterns(ctx: Ctx, resources: PdfDict | undefined, seen: Set<PdfDict>): void {
  const patterns = resolveDict(ctx.doc, resources?.get('Pattern'));
  if (!patterns) return;
  for (const v of patterns.values()) {
    const p = ctx.doc.resolve(v);
    if (!isStream(p)) continue; // shading patterns are dicts, and draw no images
    if (ctx.doc.resolve(p.dict.get('PatternType')) !== 1) continue;
    const m = numsOf(ctx.doc, p.dict.get('Matrix'));
    walkStream(ctx, p, resolveDict(ctx.doc, p.dict.get('Resources')),
      m.length === 6 ? (m as Matrix) : IDENTITY, 0, seen, true);
  }
}

/** Type3 /CharProcs. Walked with measurable=false: the CTM at a glyph draw is
 *  the font matrix times the text matrix times the CTM at show time, none of
 *  which this scan tracks. Any image drawn here is marked incomplete. */
function walkType3(ctx: Ctx, fonts: PdfDict | undefined, seen: Set<PdfDict>): void {
  if (!fonts) return;
  for (const v of fonts.values()) {
    const f = resolveDict(ctx.doc, v);
    if (!f || nameOf(ctx.doc, f.get('Subtype')) !== 'Type3') continue;
    const procs = resolveDict(ctx.doc, f.get('CharProcs'));
    if (!procs) continue;
    const res = resolveDict(ctx.doc, f.get('Resources'));
    for (const pv of procs.values()) {
      const s = ctx.doc.resolve(pv);
      if (isStream(s)) walkStream(ctx, s, res, IDENTITY, 0, seen, false);
    }
  }
}

/**
 * Per-image-stream max effective DPI across every placement in the document.
 *
 * An image the scan never reached is reported incomplete rather than omitted:
 * callers must skip it. That is the safety net that makes the policy real rather
 * than aspirational — it catches usage sites this scan does not model, and it is
 * also what (correctly) protects an /SMask, which is referenced by its parent
 * image and never drawn by a `Do`.
 */
export function collectImageUsage(doc: Document): ImageUsageMap {
  const ctx: Ctx = { doc, usage: new Map() };
  for (const page of doc.Pages) walkPage(ctx, page);

  for (const [, obj] of doc.objectEntries()) {
    if (!isStream(obj)) continue;
    if (nameOf(doc, obj.dict.get('Subtype')) !== 'Image') continue;
    if (!ctx.usage.has(obj)) {
      ctx.usage.set(obj, { maxDpi: 0, complete: false, reason: 'image not reached by the content scan' });
    }
  }
  return ctx.usage;
}
