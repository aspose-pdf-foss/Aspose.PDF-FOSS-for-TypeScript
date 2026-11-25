// Vector/path content extraction: walk a page's content (and nested Form
// XObjects), tracking the CTM, paint color, line width and clip, and emit one
// positioned path per paint operation. A focused walker (cf. imageusage.ts),
// deliberately separate from text.ts's shared visitContent.
import { createHash } from 'node:crypto';
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ContentAddr } from './editcontent.js';
import { PdfDict, PdfObject, PdfStream, isName, isArray, isDict, isStream } from './types.js';
import { parseContentStream, type ContentTokenBudget } from './content.js';
import { Matrix, IDENTITY, mul, apply, vscale } from './text.js';
import { Rgb, cmykToRgb, resolveColorSpace, deviceGray, ColorConverter } from './colorspace.js';
import { inflateStream } from './flate.js';
import { ocVisibilityFor, ocVisible, OcStack, type OcVisibility } from './ocvisible.js';
import type { ContentWalkOptions } from './text.js';
import { rethrowLimit } from './errors.js';
import { decodePageContentStreams, pageContentStreams, MAX_XOBJECT_DEPTH } from './pagecontent.js';
import { editPagePath, preparePathEdit, type PathEdit, type PathRecolorOptions } from './pathedit.js';

export type PathSegment =
  | { op: 'move'; pt: [number, number] }
  | { op: 'line'; pt: [number, number] }
  | { op: 'cubic'; c1: [number, number]; c2: [number, number]; pt: [number, number] };

export interface PathSubpath { closed: boolean; segments: PathSegment[]; }
export interface PathPaint { rgb: Rgb; space: string; }

/** Inclusive operator span of a path drawn on a page. */
export interface PagePathAddr {
  /** The first path construction operator. */
  readonly start: ContentAddr;
  /** The paint or end-path operator. */
  readonly end: ContentAddr;
  /** The enclosing Form draws, as `Do` addresses ordered from the page inward. */
  readonly invocations: readonly ContentAddr[];
}

export interface PagePath {
  subpaths: PathSubpath[];
  ctm: Matrix;
  bbox: [number, number, number, number];
  fill: PathPaint | null;
  stroke: PathPaint | null;
  fillRule: 'nonzero' | 'evenodd' | null;
  lineWidth: number;
  clip: 'nonzero' | 'evenodd' | null;
  mcid?: number;
  artifact?: boolean;
  readonly Addr: PagePathAddr;
  /** The paint or end-path operator, also available as `Addr.end`. */
  addr: ContentAddr;
}

/** A path snapshot with methods that edit its source draw while it remains current. */
export interface EditablePagePath extends PagePath {
  /** Remove the path's paint, or remove clipping if the path only clips. */
  Remove(): void;
  /** Replace fill and/or stroke color on this draw. */
  Recolor(options: PathRecolorOptions): void;
  /** Apply an affine matrix in the same local coordinates as `subpaths`. */
  Transform(matrix: Readonly<Matrix>): void;
}

type Pt = [number, number];

const nums = (ops: readonly PdfObject[]): number[] =>
  ops.filter((x): x is number => typeof x === 'number');
const num = (o: PdfObject | undefined): number => (typeof o === 'number' ? o : 0);
const cl255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
}

function resolveForm(doc: Document, resources: PdfDict | undefined, key: string): PdfStream | undefined {
  const xobjects = resolveDict(doc, resources?.get('XObject'));
  const stream = doc.resolve(xobjects?.get(key));
  if (!isStream(stream)) return undefined;
  const subtype = doc.resolve(stream.dict.get('Subtype'));
  return isName(subtype) && subtype.name === 'Form' ? stream : undefined;
}

function formResources(doc: Document, form: PdfStream, inherited: PdfDict | undefined): PdfDict | undefined {
  return resolveDict(doc, form.dict.get('Resources')) ?? inherited;
}

/** The colorspace family label for a /ColorSpace operand (name or array). */
function csFamily(doc: Document, obj: PdfObject | undefined): string {
  const r = doc.resolve(obj);
  if (isName(r)) {
    switch (r.name) {
      case 'DeviceGray': case 'G': case 'CalGray': return 'DeviceGray';
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return 'DeviceRGB';
      case 'DeviceCMYK': case 'CMYK': return 'DeviceCMYK';
      case 'Pattern': return 'Pattern';
      default: return 'Unknown';
    }
  }
  if (isArray(r) && r.length > 0) {
    const head = doc.resolve(r[0]);
    const fam = isName(head) ? head.name : '';
    switch (fam) {
      case 'ICCBased': return 'ICCBased';
      case 'Indexed': case 'I': return 'Indexed';
      case 'Separation': return 'Separation';
      case 'DeviceN': return 'DeviceN';
      case 'Lab': return 'Lab';
      case 'CalRGB': return 'CalRGB';
      case 'CalGray': return 'CalGray';
      case 'Pattern': return 'Pattern';
      default: return 'Unknown';
    }
  }
  return 'Unknown';
}

const isArtifactTag = (o: PdfObject | undefined): boolean =>
  !!o && isName(o) && o.name === 'Artifact';

/** MCID from a BDC properties operand: an inline dict, or a name resolved via
 *  /Resources /Properties. undefined when absent. */
function mcidOf(doc: Document, properties: PdfDict | undefined, operand: PdfObject | undefined): number | undefined {
  let d: PdfDict | undefined;
  if (isDict(operand)) d = operand;
  else if (isName(operand)) d = resolveDict(doc, properties?.get(operand.name));
  const m = d ? doc.resolve(d.get('MCID')) : undefined;
  return typeof m === 'number' ? m : undefined;
}

const DEVICE_CS = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK']);

/** Resolve a cs/CS operand to a converter + family, looking names up in
 *  /Resources /ColorSpace when they are not device spaces. */
function lookupCs(
  doc: Document, resources: PdfDict | undefined, operand: PdfObject | undefined,
): { conv: ColorConverter; space: string } {
  let csObj = operand;
  if (isName(operand) && !DEVICE_CS.has(operand.name)) {
    const csDict = resolveDict(doc, resources?.get('ColorSpace'));
    const found = csDict?.get(operand.name);
    if (found !== undefined) csObj = found;
  }
  const resolve = (o: PdfObject | undefined) => doc.resolve(o);
  const inflate = (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]);
  const conv = resolveColorSpace(csObj as PdfObject, resolve, inflate);
  return { conv, space: csFamily(doc, csObj) };
}

export function deviceBbox(subpaths: PathSubpath[], ctm: Matrix): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    const [dx, dy] = apply(ctm, p[0], p[1]);
    if (dx < x0) x0 = dx; if (dy < y0) y0 = dy;
    if (dx > x1) x1 = dx; if (dy > y1) y1 = dy;
  };
  for (const sp of subpaths) for (const s of sp.segments) {
    if (s.op === 'cubic') { add(s.c1); add(s.c2); add(s.pt); } else add(s.pt);
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

export interface StreamSource { stream: WeakRef<PdfStream>; digest: string; }
interface Invocation { addr: ContentAddr; source: StreamSource; }
interface PageSource {
  doc: WeakRef<Document>;
  dict: WeakRef<PdfDict>;
  top: readonly StreamSource[];
}
interface Origin {
  page: PageSource;
  trail: readonly Invocation[];
  addr: PagePathAddr;
}
const origins = new WeakMap<PagePath, Origin>();
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Snapshot and verify content shared by path and text handles. @internal */
export const snapshotStream = (stream: PdfStream, bytes: Uint8Array): StreamSource => ({ stream: new WeakRef(stream), digest: digest(bytes) });
export function sameStream(source: StreamSource, stream: PdfStream, bytes: Uint8Array): boolean {
  return stream === source.stream.deref() && digest(bytes) === source.digest;
}

function stalePath(): RangeError {
  return new RangeError('PagePath no longer addresses the page content. Call page.GetPaths() again.');
}

function editVerifiedPath(path: PagePath, edit: PathEdit): void {
  const request = preparePathEdit(edit);
  const source = origins.get(path)?.page;
  const doc = source?.doc.deref();
  const dict = source?.dict.deref();
  if (!doc || !dict) throw stalePath();
  const pageNumber = doc.pageNumberOf(dict);
  if (pageNumber === undefined) throw stalePath();
  const page = doc.Pages[pageNumber - 1];
  editPagePath(doc, page, verifyPagePath(doc, page, path), request);
}

class PathEditor {
  Remove(this: PagePath): void { editVerifiedPath(this, { kind: 'remove' }); }
  Recolor(this: PagePath, options: PathRecolorOptions): void { editVerifiedPath(this, { kind: 'recolor', options }); }
  Transform(this: PagePath, matrix: Readonly<Matrix>): void { editVerifiedPath(this, { kind: 'transform', matrix }); }
}

interface Ctx {
  doc: Document; source: PageSource; out: EditablePagePath[]; oc?: OcVisibility;
  /** The `maxContentTokens` count for this page walk, shared by every stream it
   *  parses rather than counted afresh per stream (`ibzo.8`, `ibzo.9`). */
  tokens: ContentTokenBudget;
}
interface Stream { bytes: Uint8Array; streamIndex: number; }

function walk(
  ctx: Ctx, streams: Stream[], resources: PdfDict | undefined,
  path: readonly string[], trail: readonly Invocation[], baseCtm: Matrix, seen: Set<object>,
): void {
  let ctm = baseCtm;
  let lineWidth = 1;
  let fill: PathPaint = { rgb: [0, 0, 0], space: 'DeviceGray' };
  let stroke: PathPaint = { rgb: [0, 0, 0], space: 'DeviceGray' };
  let fillConv: ColorConverter = deviceGray();
  let strokeConv: ColorConverter = deviceGray();
  const gsStack: { ctm: Matrix; lineWidth: number; fill: PathPaint; stroke: PathPaint; fillConv: ColorConverter; strokeConv: ColorConverter }[] = [];

  let subpaths: PathSubpath[] = [];
  let cur: PathSubpath | undefined;
  let curPt: Pt | undefined;
  let startPt: Pt | undefined;
  let startAddr: ContentAddr | undefined;
  let pendingClip: 'nonzero' | 'evenodd' | null = null;

  const properties = resolveDict(ctx.doc, resources?.get('Properties'));
  const mcidStack: (number | undefined)[] = [];
  const artStack: boolean[] = [];
  let activeMcid: number | undefined;
  let inArtifact = false;
  // Optional content, through the same `ocvisible.ts` rule `text.ts` and
  // `pagerender.ts` use. Inert unless the caller asked to skip.
  const oc = new OcStack(ctx.oc);

  const invocations = Object.freeze(trail.map(({ addr }) => addr));
  const reset = () => {
    subpaths = []; cur = undefined; curPt = undefined; startPt = undefined; startAddr = undefined; pendingClip = null;
  };

  const startSubpath = (x: number, y: number) => {
    cur = { closed: false, segments: [{ op: 'move', pt: [x, y] }] };
    subpaths.push(cur);
    curPt = [x, y];
    startPt = curPt;
  };
  const continueSubpath = () => {
    // A segment after h or re starts a new subpath at the closing point.
    if (cur?.closed && curPt) startSubpath(curPt[0], curPt[1]);
  };

  const setColor = (operands: readonly PdfObject[], isStroke: boolean) => {
    const hasPattern = operands.length > 0 && isName(operands[operands.length - 1]);
    const comps = nums(operands);
    const conv = isStroke ? strokeConv : fillConv;
    const space = isStroke ? stroke.space : fill.space;
    const paint: PathPaint = hasPattern
      ? { rgb: comps.length ? conv.toRgb(comps) : [0, 0, 0], space: 'Pattern' }
      : { rgb: conv.toRgb(comps), space };
    if (isStroke) stroke = paint; else fill = paint;
  };

  const emit = (addr: ContentAddr, f: boolean, s: boolean, rule: 'nonzero' | 'evenodd' | null) => {
    if (!f && !s && !pendingClip) { reset(); return; }
    if (!startAddr) { reset(); return; }
    // Hidden: report nothing, but RESET as always — the accumulated subpaths and
    // the pending clip belong to this paint op, and carrying them forward would
    // give the next VISIBLE path the hidden one's geometry. That is the analogue
    // of `pagerender.ts` flushing a hidden clip rather than returning early.
    // A clip-only path is suppressed too: `GetPaths` reports what the page
    // PAINTS, a hidden `W n` paints nothing, and no consumer in src/ reads
    // `PagePath.clip`.
    if (oc.hidden) { reset(); return; }
    const address: PagePathAddr = Object.freeze({ start: startAddr, end: Object.freeze(addr), invocations });
    const result: EditablePagePath = Object.assign(new PathEditor(), {
      subpaths: subpaths.map((sp) => ({ closed: sp.closed, segments: sp.segments.slice() })),
      ctm,
      bbox: deviceBbox(subpaths, ctm),
      fill: f ? { rgb: fill.rgb, space: fill.space } : null,
      stroke: s ? { rgb: stroke.rgb, space: stroke.space } : null,
      fillRule: f ? rule : null,
      lineWidth: s ? lineWidth * vscale(ctm) : 0,
      clip: pendingClip,
      mcid: activeMcid,
      artifact: inArtifact || undefined,
      Addr: address,
      addr: address.end,
    });
    origins.set(result, { page: ctx.source, trail, addr: address });
    ctx.out.push(result);
    reset();
  };

  for (const { bytes, streamIndex } of streams) {
    let ops;
    try { ops = parseContentStream(bytes, ctx.doc.loadLimits, ctx.tokens); } catch (caught) { rethrowLimit(caught); continue; }
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex];
      const addr: ContentAddr = { path, streamIndex, opIndex };
      const n = nums(op.operands);
      switch (op.operator) {
        case 'q': gsStack.push({ ctm, lineWidth, fill, stroke, fillConv, strokeConv }); break;
        case 'Q': { const g = gsStack.pop(); if (g) { ctm = g.ctm; lineWidth = g.lineWidth; fill = g.fill; stroke = g.stroke; fillConv = g.fillConv; strokeConv = g.strokeConv; } break; }
        case 'cm': if (n.length === 6) ctm = mul(n as Matrix, ctm); break;
        case 'w': lineWidth = num(op.operands[0]); break;
        // path construction
        case 'm':
          startAddr ??= Object.freeze(addr);
          startSubpath(n[0], n[1]);
          break;
        case 'l': if (cur && n.length >= 2) {
          continueSubpath();
          cur.segments.push({ op: 'line', pt: [n[0], n[1]] });
          curPt = [n[0], n[1]];
        } break;
        case 'c': if (cur && n.length >= 6) {
          continueSubpath();
          cur.segments.push({ op: 'cubic', c1: [n[0], n[1]], c2: [n[2], n[3]], pt: [n[4], n[5]] });
          curPt = [n[4], n[5]];
        } break;
        case 'v': if (cur && curPt && n.length >= 4) {
          continueSubpath();
          cur.segments.push({ op: 'cubic', c1: [curPt[0], curPt[1]], c2: [n[0], n[1]], pt: [n[2], n[3]] });
          curPt = [n[2], n[3]];
        } break;
        case 'y': if (cur && n.length >= 4) {
          continueSubpath();
          cur.segments.push({ op: 'cubic', c1: [n[0], n[1]], c2: [n[2], n[3]], pt: [n[2], n[3]] });
          curPt = [n[2], n[3]];
        } break;
        case 're': if (n.length >= 4) {
          startAddr ??= Object.freeze(addr);
          const [x, y, w, h] = n;
          cur = { closed: true, segments: [
            { op: 'move', pt: [x, y] }, { op: 'line', pt: [x + w, y] },
            { op: 'line', pt: [x + w, y + h] }, { op: 'line', pt: [x, y + h] },
          ] };
          subpaths.push(cur); curPt = [x, y]; startPt = [x, y];
        } break;
        case 'h': if (cur) { cur.closed = true; if (startPt) curPt = startPt; } break;
        // device colors
        case 'g': { const v = cl255(num(op.operands[0])); fill = { rgb: [v, v, v], space: 'DeviceGray' }; break; }
        case 'G': { const v = cl255(num(op.operands[0])); stroke = { rgb: [v, v, v], space: 'DeviceGray' }; break; }
        case 'rg': fill = { rgb: [cl255(n[0] ?? 0), cl255(n[1] ?? 0), cl255(n[2] ?? 0)], space: 'DeviceRGB' }; break;
        case 'RG': stroke = { rgb: [cl255(n[0] ?? 0), cl255(n[1] ?? 0), cl255(n[2] ?? 0)], space: 'DeviceRGB' }; break;
        case 'k': fill = { rgb: cmykToRgb(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0), space: 'DeviceCMYK' }; break;
        case 'K': stroke = { rgb: cmykToRgb(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0), space: 'DeviceCMYK' }; break;
        // colorspace-based colors
        case 'cs': { const { conv, space } = lookupCs(ctx.doc, resources, op.operands[0]); fillConv = conv; fill = { rgb: conv.initial(), space }; break; }
        case 'CS': { const { conv, space } = lookupCs(ctx.doc, resources, op.operands[0]); strokeConv = conv; stroke = { rgb: conv.initial(), space }; break; }
        case 'sc': case 'scn': setColor(op.operands, false); break;
        case 'SC': case 'SCN': setColor(op.operands, true); break;
        // marked content
        case 'BMC': mcidStack.push(activeMcid); artStack.push(inArtifact); oc.bmc(); if (isArtifactTag(op.operands[0])) inArtifact = true; break;
        case 'BDC': {
          mcidStack.push(activeMcid); artStack.push(inArtifact);
          oc.bdc(op.operands[0], op.operands[1], properties);
          if (isArtifactTag(op.operands[0])) inArtifact = true;
          const m = mcidOf(ctx.doc, properties, op.operands[1]);
          if (m !== undefined) activeMcid = m;
          break;
        }
        case 'EMC': if (mcidStack.length) activeMcid = mcidStack.pop(); if (artStack.length) inArtifact = artStack.pop()!; oc.emc(); break;
        // clip
        case 'W': pendingClip = 'nonzero'; break;
        case 'W*': pendingClip = 'evenodd'; break;
        // paint
        case 'S': emit(addr, false, true, null); break;
        case 's': if (cur) cur.closed = true; emit(addr, false, true, null); break;
        case 'f': case 'F': emit(addr, true, false, 'nonzero'); break;
        case 'f*': emit(addr, true, false, 'evenodd'); break;
        case 'B': emit(addr, true, true, 'nonzero'); break;
        case 'B*': emit(addr, true, true, 'evenodd'); break;
        case 'b': if (cur) cur.closed = true; emit(addr, true, true, 'nonzero'); break;
        case 'b*': if (cur) cur.closed = true; emit(addr, true, true, 'evenodd'); break;
        case 'n': emit(addr, false, false, null); break;
        case 'Do': {
          const xn = op.operands[0];
          if (!isName(xn)) break;
          const xo = resolveForm(ctx.doc, resources, xn.name);
          if (!xo) break;
          if (oc.hidden || !ocVisible(ctx.oc, xo.dict.get('OC'))) break;
          if (trail.length >= MAX_XOBJECT_DEPTH || seen.has(xo.dict)) break;
          seen.add(xo.dict);
          const mo = ctx.doc.resolve(xo.dict.get('Matrix'));
          const mat = isArray(mo) ? nums(mo) : [];
          const childCtm = mat.length === 6 ? mul(mat as Matrix, ctm) : ctm;
          const childRes = formResources(ctx.doc, xo, resources);
          let childBytes: Uint8Array;
          try { childBytes = inflateStream(xo); }
          catch (caught) { rethrowLimit(caught); seen.delete(xo.dict); break; }
          const draw: Invocation = { addr: Object.freeze(addr), source: snapshotStream(xo, childBytes) };
          walk(ctx, [{ bytes: childBytes, streamIndex: 0 }], childRes,
            Object.freeze([...path, xn.name]), [...trail, draw], childCtm, seen);
          seen.delete(xo.dict);
          break;
        }
        default: break;
      }
    }
  }
}

/** Extract painted vector paths from a page (top-level content and nested Form
 *  XObjects). Never throws; returns [] on decode failure. */
export function extractPaths(doc: Document, page: Page, opts: ContentWalkOptions = {}): EditablePagePath[] {
  let streams: PdfStream[];
  let bytes: Uint8Array[];
  try {
    streams = pageContentStreams(doc, page);
    bytes = decodePageContentStreams(streams);
  } catch (caught) { rethrowLimit(caught); return []; }
  const source: PageSource = {
    doc: new WeakRef(doc),
    dict: new WeakRef(page.Dict),
    top: streams.map((stream, i) => snapshotStream(stream, bytes[i])),
  };
  const ctx: Ctx = { doc, source, out: [], tokens: { tokens: 0 }, oc: opts.skipHidden ? ocVisibilityFor(doc) : undefined };
  walk(ctx, bytes.map((b, i) => ({ bytes: b, streamIndex: i })), page.Resources, Object.freeze([]), [], IDENTITY, new Set());
  return ctx.out;
}

/** Verify the live source before entering EditableContent's copy-on-write path. @internal */
export function verifyPagePath(doc: Document, page: Page, path: PagePath): PagePathAddr {
  const origin = origins.get(path);
  if (origin && origin.page.doc.deref() === doc && origin.page.dict.deref() === page.Dict
      && origin.addr === path.Addr && page.Document === doc && doc.pageNumberOf(page.Dict) !== undefined) {
    try {
      if (sourcesMatch(doc, page, origin)) return origin.addr;
    } catch (caught) {
      rethrowLimit(caught);
    }
  }
  throw stalePath();
}

function sourcesMatch(doc: Document, page: Page, origin: Origin): boolean {
  const streams = pageContentStreams(doc, page);
  const top = origin.page.top;
  if (streams.length !== top.length || streams.some((stream, i) => stream !== top[i].stream.deref())) return false;
  const bytes = decodePageContentStreams(streams);
  if (bytes.some((value, i) => !sameStream(top[i], streams[i], value))) return false;

  let resources = page.Resources;
  for (let i = 0; i < origin.trail.length; i++) {
    const { source } = origin.trail[i];
    const form = resolveForm(doc, resources, origin.addr.end.path[i]);
    if (!form || form !== source.stream.deref() || !sameStream(source, form, inflateStream(form))) return false;
    resources = formResources(doc, form, resources);
  }
  return true;
}
