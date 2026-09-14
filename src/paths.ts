// Vector/path content extraction: walk a page's content (and nested Form
// XObjects), tracking the CTM, paint color, line width and clip, and emit one
// positioned path per paint operation. A focused walker (cf. imageusage.ts),
// deliberately separate from text.ts's shared visitContent.
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ContentAddr } from './editcontent.js';
import { PdfDict, PdfObject, isName, isArray, isDict, isStream } from './types.js';
import { parseContentStream } from './content.js';
import { Matrix, IDENTITY, mul, apply, vscale, contentStreamBytes } from './text.js';
import { Rgb, cmykToRgb, resolveColorSpace, deviceGray, ColorConverter } from './colorspace.js';
import { inflateStream } from './flate.js';
import { ocVisibilityFor, ocVisible, OcStack, type OcVisibility } from './ocvisible.js';
import type { ContentWalkOptions } from './text.js';

export type PathSegment =
  | { op: 'move'; pt: [number, number] }
  | { op: 'line'; pt: [number, number] }
  | { op: 'cubic'; c1: [number, number]; c2: [number, number]; pt: [number, number] };

export interface PathSubpath { closed: boolean; segments: PathSegment[]; }
export interface PathPaint { rgb: Rgb; space: string; }

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
  addr: ContentAddr;
}

const MAX_XOBJECT_DEPTH = 8;
type Pt = [number, number];

const nums = (ops: readonly PdfObject[]): number[] =>
  ops.filter((x): x is number => typeof x === 'number');
const num = (o: PdfObject | undefined): number => (typeof o === 'number' ? o : 0);
const cl255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
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

function deviceBbox(subpaths: PathSubpath[], ctm: Matrix): [number, number, number, number] {
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

interface Ctx { doc: Document; out: PagePath[]; oc?: OcVisibility; }
interface Stream { bytes: Uint8Array; streamIndex: number; }

function walk(
  ctx: Ctx, streams: Stream[], resources: PdfDict | undefined,
  path: string[], baseCtm: Matrix, depth: number, seen: Set<object>,
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
  let pendingClip: 'nonzero' | 'evenodd' | null = null;

  const properties = resolveDict(ctx.doc, resources?.get('Properties'));
  const mcidStack: (number | undefined)[] = [];
  const artStack: boolean[] = [];
  let activeMcid: number | undefined;
  let inArtifact = false;
  // Optional content, through the same `ocvisible.ts` rule `text.ts` and
  // `pagerender.ts` use. Inert unless the caller asked to skip.
  const oc = new OcStack(ctx.oc);

  const reset = () => { subpaths = []; cur = undefined; curPt = undefined; startPt = undefined; pendingClip = null; };

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
    if (subpaths.length === 0) { reset(); return; }
    // Hidden: report nothing, but RESET as always — the accumulated subpaths and
    // the pending clip belong to this paint op, and carrying them forward would
    // give the next VISIBLE path the hidden one's geometry. That is the analogue
    // of `pagerender.ts` flushing a hidden clip rather than returning early.
    // A clip-only path is suppressed too: `GetPaths` reports what the page
    // PAINTS, a hidden `W n` paints nothing, and no consumer in src/ reads
    // `PagePath.clip`.
    if (oc.hidden) { reset(); return; }
    ctx.out.push({
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
      addr,
    });
    reset();
  };

  for (const { bytes, streamIndex } of streams) {
    let ops;
    try { ops = parseContentStream(bytes); } catch { continue; }
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex];
      const addr: ContentAddr = { path: [...path], streamIndex, opIndex };
      const n = nums(op.operands);
      switch (op.operator) {
        case 'q': gsStack.push({ ctm, lineWidth, fill, stroke, fillConv, strokeConv }); break;
        case 'Q': { const g = gsStack.pop(); if (g) { ctm = g.ctm; lineWidth = g.lineWidth; fill = g.fill; stroke = g.stroke; fillConv = g.fillConv; strokeConv = g.strokeConv; } break; }
        case 'cm': if (n.length === 6) ctm = mul(n as Matrix, ctm); break;
        case 'w': lineWidth = num(op.operands[0]); break;
        // path construction
        case 'm': cur = { closed: false, segments: [{ op: 'move', pt: [n[0], n[1]] }] }; subpaths.push(cur); curPt = [n[0], n[1]]; startPt = [n[0], n[1]]; break;
        case 'l': if (cur && n.length >= 2) { cur.segments.push({ op: 'line', pt: [n[0], n[1]] }); curPt = [n[0], n[1]]; } break;
        case 'c': if (cur && n.length >= 6) { cur.segments.push({ op: 'cubic', c1: [n[0], n[1]], c2: [n[2], n[3]], pt: [n[4], n[5]] }); curPt = [n[4], n[5]]; } break;
        case 'v': if (cur && curPt && n.length >= 4) { cur.segments.push({ op: 'cubic', c1: [curPt[0], curPt[1]], c2: [n[0], n[1]], pt: [n[2], n[3]] }); curPt = [n[2], n[3]]; } break;
        case 'y': if (cur && n.length >= 4) { cur.segments.push({ op: 'cubic', c1: [n[0], n[1]], c2: [n[2], n[3]], pt: [n[2], n[3]] }); curPt = [n[2], n[3]]; } break;
        case 're': if (n.length >= 4) {
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
          const xobjects = resolveDict(ctx.doc, resources?.get('XObject'));
          if (!isName(xn) || !xobjects) break;
          const xo = ctx.doc.resolve(xobjects.get(xn.name));
          if (!isStream(xo)) break;
          const sub = ctx.doc.resolve(xo.dict.get('Subtype'));
          if (!(isName(sub) && sub.name === 'Form')) break;   // images/others: no paths
          if (oc.hidden || !ocVisible(ctx.oc, xo.dict.get('OC'))) break;
          if (depth >= MAX_XOBJECT_DEPTH || seen.has(xo.dict)) break;
          seen.add(xo.dict);
          const mo = ctx.doc.resolve(xo.dict.get('Matrix'));
          const mat = isArray(mo) ? nums(mo) : [];
          const childCtm = mat.length === 6 ? mul(mat as Matrix, ctm) : ctm;
          const childRes = resolveDict(ctx.doc, xo.dict.get('Resources')) ?? resources;
          let childBytes: Uint8Array;
          try { childBytes = inflateStream(xo as Parameters<typeof inflateStream>[0]); }
          catch { seen.delete(xo.dict); break; }
          walk(ctx, [{ bytes: childBytes, streamIndex: 0 }], childRes, [...path, xn.name], childCtm, depth + 1, seen);
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
export function extractPaths(doc: Document, page: Page, opts: ContentWalkOptions = {}): PagePath[] {
  const ctx: Ctx = { doc, out: [], oc: opts.skipHidden ? ocVisibilityFor(doc) : undefined };
  let bytes: Uint8Array[];
  try { bytes = contentStreamBytes(doc, page); } catch { return []; }
  walk(ctx, bytes.map((b, i) => ({ bytes: b, streamIndex: i })), page.Resources, [], IDENTITY, 0, new Set());
  return ctx.out;
}
