import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString, name } from './types.js';
import { buildAppearanceXObject, installAP, widgetGeom, wrapTextBody, type WidgetGeom } from './appearance.js';
import { num } from './pagecontent.js';
import { decodePdfText } from './metadata.js';
import { parseDA } from './da.js';
import { measure } from './metrics.js';
import { encodeWinAnsi } from './encoding.js';
import { serializeString } from './serialize.js';
import type { LineEnding } from './annotation.js';

/** The /Resources /Font key every annotation appearance registers its Standard-14
 *  face under. Single source: `installShapeAP` registers it and every body
 *  producer in this module names it. The two used to be independent hardcodes
 *  that disagreed — see the `wrapTextBody` note in appearance.ts (bug cu3b).
 *  Distinct from the *field* appearance path in appearance.ts, which registers
 *  and names 'Helv' throughout. */
export const AP_FONT_KEY = 'F0';

/** A quad's four corners (PDF QuadPoints order: 1=TL, 2=TR, 3=BL, 4=BR). */
export interface QuadCorners {
  x1: number; y1: number; x2: number; y2: number;
  x3: number; y3: number; x4: number; y4: number;
}

/** Axis-aligned bounding box over all corner points of `quads`. */
export function quadsBBox(quads: number[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < quads.length; i += 2) {
    const x = quads[i], y = quads[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Split `quads` into per-quad corners, translated into form space (origin at
 *  the quad bbox lower-left, so the form /BBox [0 0 w h] maps onto /Rect). */
export function offsetQuads(quads: number[], minX: number, minY: number): QuadCorners[] {
  const out: QuadCorners[] = [];
  for (let i = 0; i < quads.length; i += 8) {
    out.push({
      x1: quads[i] - minX,     y1: quads[i + 1] - minY,
      x2: quads[i + 2] - minX, y2: quads[i + 3] - minY,
      x3: quads[i + 4] - minX, y3: quads[i + 5] - minY,
      x4: quads[i + 6] - minX, y4: quads[i + 7] - minY,
    });
  }
  return out;
}

/** Fill each quad with the markup color (TL→TR→BR→BL polygon). */
export function drawHighlight(qs: QuadCorners[], color: [number, number, number]): string {
  const [r, g, b] = color;
  let s = `${num(r)} ${num(g)} ${num(b)} rg\n`;
  for (const q of qs) {
    s += `${num(q.x1)} ${num(q.y1)} m ${num(q.x2)} ${num(q.y2)} l ` +
      `${num(q.x4)} ${num(q.y4)} l ${num(q.x3)} ${num(q.y3)} l f\n`;
  }
  return s;
}

/** Pending redaction mark: stroke each quad's outline in the mark colour and
 *  fill nothing, so the content underneath stays readable.
 *
 *  It must not look like an applied redaction. Both the renderers and
 *  FlattenAnnotations composite /AP /N, so a filled preview would render a page
 *  whose text is still fully extractable as though it were already redacted. */
export function redactMarkBody(qs: QuadCorners[], color: [number, number, number]): string {
  const [r, g, b] = color;
  let s = `${num(r)} ${num(g)} ${num(b)} RG\n1 w\n`;
  for (const q of qs) {
    // Same TL→TR→BR→BL corner order as drawHighlight.
    s += `${num(q.x1)} ${num(q.y1)} m ${num(q.x2)} ${num(q.y2)} l ` +
      `${num(q.x4)} ${num(q.y4)} l ${num(q.x3)} ${num(q.y3)} l h S\n`;
  }
  return s;
}

/** Per-quad geometry: left/right x span, bottom y, and quad height. */
function quadSpan(q: QuadCorners): { xl: number; xr: number; yb: number; h: number } {
  const xl = Math.min(q.x1, q.x2, q.x3, q.x4);
  const xr = Math.max(q.x1, q.x2, q.x3, q.x4);
  const yb = Math.min(q.y1, q.y2, q.y3, q.y4);
  const yt = Math.max(q.y1, q.y2, q.y3, q.y4);
  return { xl, xr, yb, h: yt - yb };
}

/** Stroke a horizontal line across each quad at fractional height `frac`
 *  (0 = bottom, 0.5 = middle), with width proportional to quad height. */
export function strokeLines(qs: QuadCorners[], color: [number, number, number], frac: number): string {
  const [r, g, b] = color;
  let s = `${num(r)} ${num(g)} ${num(b)} RG\n`;
  for (const q of qs) {
    const { xl, xr, yb, h } = quadSpan(q);
    const lw = Math.max(0.5, h * 0.06);
    const y = yb + h * frac + (frac === 0 ? lw : 0);
    s += `${num(lw)} w ${num(xl)} ${num(y)} m ${num(xr)} ${num(y)} l S\n`;
  }
  return s;
}

/** Underline: a stroke along the bottom edge of each quad. */
export function drawUnderline(qs: QuadCorners[], color: [number, number, number]): string {
  return strokeLines(qs, color, 0);
}

/** Strike-out: a stroke through the middle of each quad. */
export function drawStrikeOut(qs: QuadCorners[], color: [number, number, number]): string {
  return strokeLines(qs, color, 0.5);
}

/** Stroke a zig-zag along the bottom of each quad. */
export function drawSquiggly(qs: QuadCorners[], color: [number, number, number]): string {
  const [r, g, b] = color;
  let s = `${num(r)} ${num(g)} ${num(b)} RG\n`;
  for (const q of qs) {
    const { xl, xr, yb, h } = quadSpan(q);
    const amp = Math.max(1, h * 0.1);
    const step = Math.max(2, amp);
    const lw = Math.max(0.5, h * 0.04);
    s += `${num(lw)} w ${num(xl)} ${num(yb)} m\n`;
    let up = true;
    for (let x = xl + step; x < xr; x += step) {
      s += `${num(x)} ${num(up ? yb + amp : yb)} l\n`;
      up = !up;
    }
    s += `${num(xr)} ${num(yb)} l S\n`;
  }
  return s;
}

/** Body for a text box of size w×h at the origin: optional fill, optional inset
 *  border stroke, then wrapped/aligned text (text inset by the border width). */
export function freeTextBoxBody(
  w: number, h: number, contents: string, fontSize: number,
  textColor: [number, number, number], align: 'left' | 'center' | 'right',
  color: [number, number, number], fill: [number, number, number] | undefined, width: number,
): string {
  let s = '';
  if (fill) s += `${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg\n0 0 ${num(w)} ${num(h)} re f\n`;
  if (width > 0) {
    const half = width / 2;
    s += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n` +
      `${num(half)} ${num(half)} ${num(w - width)} ${num(h - width)} re S\n`;
  }
  s += wrapTextBody(contents, 'Helvetica', fontSize, textColor, w, h, width, align, AP_FONT_KEY);
  return s;
}

/** Install `body` as the annotation's /AP /N, wrapping in a /GS0 ExtGState when
 *  opacity < 1 (matching the markup opacity path). */
export function installShapeAP(doc: Document, dict: PdfDict, g: WidgetGeom, body: string, opacity: number): void {
  let full = '';
  if (opacity < 1) full += '/GS0 gs\n';
  full += body;
  const stream = buildAppearanceXObject(doc, g, 'Helvetica', AP_FONT_KEY, full);
  if (opacity < 1) {
    const gsDict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('ExtGState')], ['ca', opacity], ['CA', opacity],
    ]);
    (stream.dict.get('Resources') as PdfDict).set(
      'ExtGState', new Map<string, PdfObject>([['GS0', doc.allocObject(gsDict)]]),
    );
  }
  installAP(doc, dict, stream);
}

/** Painting op for the fill/stroke selection: B = both, S = stroke, f = fill. */
export function paintOp(stroke: boolean, fill: boolean): string {
  if (stroke && fill) return 'B';
  if (fill) return 'f';
  return 'S';
}

/** Rectangle inset by half the border so the stroke stays inside the box. */
export function drawRect(g: WidgetGeom, color: [number, number, number], fill: [number, number, number] | undefined, width: number): string {
  const half = width / 2;
  const x = half, y = half, w = g.w - width, h = g.h - width;
  let s = '';
  if (fill) s += `${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg\n`;
  s += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
  s += `${num(x)} ${num(y)} ${num(w)} ${num(h)} re\n`;
  return s + paintOp(width > 0, fill !== undefined) + '\n';
}

/** Ellipse inscribed in the inset rect via 4 Bézier quarter-arcs. */
export function drawEllipse(g: WidgetGeom, color: [number, number, number], fill: [number, number, number] | undefined, width: number): string {
  const half = width / 2;
  const x0 = half, y0 = half, w = g.w - width, h = g.h - width;
  const cx = x0 + w / 2, cy = y0 + h / 2, rx = w / 2, ry = h / 2;
  const k = 0.5523;               // circle→Bézier control-point ratio
  const ox = rx * k, oy = ry * k;
  let s = '';
  if (fill) s += `${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg\n`;
  s += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
  s += `${num(cx + rx)} ${num(cy)} m\n`;
  s += `${num(cx + rx)} ${num(cy + oy)} ${num(cx + ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c\n`;
  s += `${num(cx - ox)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + oy)} ${num(cx - rx)} ${num(cy)} c\n`;
  s += `${num(cx - rx)} ${num(cy - oy)} ${num(cx - ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c\n`;
  s += `${num(cx + ox)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - oy)} ${num(cx + rx)} ${num(cy)} c\n`;
  return s + paintOp(width > 0, fill !== undefined) + '\n';
}

/** Fraction of the width the paragraph sign takes when /Sy is /P. */
const CARET_SYMBOL_SHARE = 0.4;

/** A text-insertion caret: a filled wedge whose two sides curve *inward* to a
 *  sharp apex, on a flat baseline — the proofreader's caret, not a triangle.
 *  With `symbol: 'paragraph'` a WinAnsi paragraph sign is drawn in the leftmost
 *  40% of the box and the caret takes the remaining 60%.
 *
 *  `rd` is the annotation's /RD, the difference between /Rect and the caret's
 *  own boundary. We never author one, but another producer may; applying it here
 *  keeps that rule in a single place rather than at each call site. */
export function caretBody(
  g: WidgetGeom, color: [number, number, number],
  symbol: 'none' | 'paragraph', rd?: number[],
): string {
  // /RD is [left, top, right, bottom] (32000-1 table 164).
  const [dl, dt, dr, db] = rd !== undefined && rd.length === 4 ? rd : [0, 0, 0, 0];
  const x = dl, y = db;
  const w = g.w - dl - dr, h = g.h - dt - db;
  if (w <= 0 || h <= 0) return ''; // nothing left to draw in

  const [r, gg, b] = color;
  let s = `${num(r)} ${num(gg)} ${num(b)} rg\n`;

  const cw = symbol === 'paragraph' ? w * (1 - CARET_SYMBOL_SHARE) : w;
  const x0 = symbol === 'paragraph' ? x + w * CARET_SYMBOL_SHARE : x;
  const x1 = x0 + cw, cx = x0 + cw / 2, y1 = y + h;

  // Control points sit inside the straight edge (linear would be 0.167w/0.333w
  // at these heights), which is what bows each side toward the centre.
  s += `${num(x0)} ${num(y)} m\n`;
  s += `${num(x0 + cw * 0.30)} ${num(y + h * 0.33)} ` +
       `${num(x0 + cw * 0.42)} ${num(y + h * 0.72)} ${num(cx)} ${num(y1)} c\n`;
  s += `${num(x1 - cw * 0.42)} ${num(y + h * 0.72)} ` +
       `${num(x1 - cw * 0.30)} ${num(y + h * 0.33)} ${num(x1)} ${num(y)} c\n`;
  s += 'h f\n';

  if (symbol === 'paragraph') {
    const size = h * 0.7;
    const bytes = encodeWinAnsi('¶');
    const tw = measure('Helvetica', bytes, size);
    const sx = x + Math.max(0, (w * CARET_SYMBOL_SHARE - tw) / 2);
    const sy = y + (h - size * 0.7) / 2;
    s += `BT\n/${AP_FONT_KEY} ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n` +
         `${num(sx)} ${num(sy)} Td\n${serializeString(bytes)} Tj\nET\n`;
  }
  return s;
}

/** Rotate vector (vx,vy) by angle `a` radians. */
export function rot(vx: number, vy: number, a: number): [number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  return [vx * c - vy * s, vx * s + vy * c];
}

/** Draw an /LE ending at (px,py). (dx,dy) is the outward unit direction the
 *  ending points (away from the line). Arrowheads fill/stroke with `color`. */
export function drawEnding(px: number, py: number, dx: number, dy: number, ending: LineEnding, size: number, color: [number, number, number]): string {
  if (ending === 'None') return '';
  const [r, g, b] = color;
  if (ending === 'Square') {
    const rad = size / 2;
    return `${num(r)} ${num(g)} ${num(b)} rg\n` +
      `${num(px - rad)} ${num(py - rad)} ${num(2 * rad)} ${num(2 * rad)} re f\n`;
  }
  if (ending === 'Circle') {
    const rad = size / 2, k = 0.5523 * rad;
    return `${num(r)} ${num(g)} ${num(b)} rg\n` +
      `${num(px + rad)} ${num(py)} m\n` +
      `${num(px + rad)} ${num(py + k)} ${num(px + k)} ${num(py + rad)} ${num(px)} ${num(py + rad)} c\n` +
      `${num(px - k)} ${num(py + rad)} ${num(px - rad)} ${num(py + k)} ${num(px - rad)} ${num(py)} c\n` +
      `${num(px - rad)} ${num(py - k)} ${num(px - k)} ${num(py - rad)} ${num(px)} ${num(py - rad)} c\n` +
      `${num(px + k)} ${num(py - rad)} ${num(px + rad)} ${num(py - k)} ${num(px + rad)} ${num(py)} c\nf\n`;
  }
  // OpenArrow / ClosedArrow: two barbs from the reversed outward direction.
  const theta = 0.5236; // 30°
  const [b1x, b1y] = rot(-dx, -dy, theta);
  const [b2x, b2y] = rot(-dx, -dy, -theta);
  const p1x = px + b1x * size, p1y = py + b1y * size;
  const p2x = px + b2x * size, p2y = py + b2y * size;
  if (ending === 'ClosedArrow') {
    return `${num(r)} ${num(g)} ${num(b)} rg\n` +
      `${num(px)} ${num(py)} m ${num(p1x)} ${num(p1y)} l ${num(p2x)} ${num(p2y)} l f\n`;
  }
  return `${num(r)} ${num(g)} ${num(b)} RG\n` +
    `${num(p1x)} ${num(p1y)} m ${num(px)} ${num(py)} l ${num(p2x)} ${num(p2y)} l S\n`;
}

/** Bounding box over a flat point list, padded by `margin`, as an annotation
 *  /Rect [llx, lly, urx, ury]. */
export function paddedRect(pts: number[], margin: number): [number, number, number, number] {
  const { minX, minY, maxX, maxY } = quadsBBox(pts);
  return [minX - margin, minY - margin, maxX + margin, maxY + margin];
}

/** Translate a flat point list into form space (origin at the /Rect lower-left). */
export function toFormSpace(pts: number[], minX: number, minY: number): number[] {
  return pts.map((v, i) => (i % 2 === 0 ? v - minX : v - minY));
}

/** Unit direction from (ax,ay) toward (bx,by); (0,0)→(1,0) fallback. */
export function unitDir(ax: number, ay: number, bx: number, by: number): [number, number] {
  const len = Math.hypot(bx - ax, by - ay) || 1;
  return [(bx - ax) / len, (by - ay) / len];
}

/** Path body: move to the first point, line to the rest, optional close (`h`),
 *  then the fill/stroke paint op. `pts` are already in form space. */
export function polyPathBody(
  pts: number[], close: boolean, color: [number, number, number],
  fill: [number, number, number] | undefined, width: number,
): string {
  let s = '';
  if (fill) s += `${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg\n`;
  s += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
  s += `${num(pts[0])} ${num(pts[1])} m `;
  for (let i = 2; i < pts.length; i += 2) s += `${num(pts[i])} ${num(pts[i + 1])} l `;
  if (close) s += 'h ';
  return s + '\n' + paintOp(width > 0, fill !== undefined) + '\n';
}

// ---------------------------------------------------------------------------
// Regeneration: the same drawing code, driven by an existing annotation dict
// rather than by an options object. Used on the data-import path, where an
// annotation arrives with properties but no usable appearance.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

/** RGB from an annotation colour array; undefined when absent or malformed. */
function colorOf(doc: Document, o: PdfObject | undefined): RGB | undefined {
  const a = doc.resolve(o);
  if (!isArray(a) || a.length !== 3) return undefined;
  const c: number[] = [];
  for (const e of a) {
    const v = doc.resolve(e);
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    c.push(v);
  }
  return [c[0], c[1], c[2]];
}

/** Border width from /BS /W, defaulting to 1 as the Add* path does. */
function widthOf(doc: Document, dict: PdfDict): number {
  const bs = doc.resolve(dict.get('BS'));
  if (isDict(bs)) {
    const w = doc.resolve(bs.get('W'));
    if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return w;
  }
  return 1;
}

/** A flat finite-number list from an array entry; [] when absent or malformed. */
function numsOf(doc: Document, o: PdfObject | undefined): number[] {
  const a = doc.resolve(o);
  if (!isArray(a)) return [];
  const out: number[] = [];
  for (const e of a) {
    const v = doc.resolve(e);
    if (typeof v !== 'number' || !Number.isFinite(v)) return [];
    out.push(v);
  }
  return out;
}

/** An /LE pair as ending names, defaulting to None. */
function endingsOf(doc: Document, dict: PdfDict): [LineEnding, LineEnding] {
  const le = doc.resolve(dict.get('LE'));
  if (!isArray(le) || le.length !== 2) return ['None', 'None'];
  const s = doc.resolve(le[0]);
  const e = doc.resolve(le[1]);
  return [
    isName(s) ? (s.name as LineEnding) : 'None',
    isName(e) ? (e.name as LineEnding) : 'None',
  ];
}

/** Body for /Line, from /L and /LE. */
function lineBody(doc: Document, dict: PdfDict, minX: number, minY: number, color: RGB, width: number): string | undefined {
  const l = numsOf(doc, dict.get('L'));
  if (l.length !== 4) return undefined;
  const [start, end] = endingsOf(doc, dict);
  const endingSize = Math.max(8, width * 3);
  const ax = l[0] - minX, ay = l[1] - minY, bx = l[2] - minX, by = l[3] - minY;
  let body = `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
  body += `${num(ax)} ${num(ay)} m ${num(bx)} ${num(by)} l S\n`;
  const [ux, uy] = unitDir(ax, ay, bx, by);
  body += drawEnding(ax, ay, -ux, -uy, start, endingSize, color);
  body += drawEnding(bx, by, ux, uy, end, endingSize, color);
  return body;
}

/** Body for /Polygon and /PolyLine, from /Vertices (and /LE for the open form). */
function polyBody(
  doc: Document, dict: PdfDict, closed: boolean, minX: number, minY: number,
  color: RGB, fill: RGB | undefined, width: number,
): string | undefined {
  const v = numsOf(doc, dict.get('Vertices'));
  if (v.length < 4 || v.length % 2 !== 0) return undefined;
  const pts = toFormSpace(v, minX, minY);
  if (closed) return polyPathBody(pts, true, color, fill, width);

  let body = polyPathBody(pts, false, color, undefined, width);
  const [start, end] = endingsOf(doc, dict);
  const endingSize = Math.max(8, width * 3);
  const n = pts.length;
  const [sx, sy] = unitDir(pts[2], pts[3], pts[0], pts[1]);
  body += drawEnding(pts[0], pts[1], sx, sy, start, endingSize, color);
  const [ex, ey] = unitDir(pts[n - 4], pts[n - 3], pts[n - 2], pts[n - 1]);
  body += drawEnding(pts[n - 2], pts[n - 1], ex, ey, end, endingSize, color);
  return body;
}

/** Body for /Ink, from /InkList: one open stroke per subpath. */
function inkBody(doc: Document, dict: PdfDict, minX: number, minY: number, color: RGB, width: number): string | undefined {
  const list = doc.resolve(dict.get('InkList'));
  if (!isArray(list) || list.length === 0) return undefined;
  let body = `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
  let drew = false;
  for (const strokeRaw of list) {
    const stroke = numsOf(doc, strokeRaw);
    if (stroke.length < 4 || stroke.length % 2 !== 0) continue;
    const pts = toFormSpace(stroke, minX, minY);
    body += `${num(pts[0])} ${num(pts[1])} m `;
    for (let i = 2; i < pts.length; i += 2) body += `${num(pts[i])} ${num(pts[i + 1])} l `;
    body += 'S\n';
    drew = true;
  }
  return drew ? body : undefined;
}

/** Body for /FreeText, from /Contents, /DA, /Q and /RD (plus /CL when present). */
function freeTextBody(
  doc: Document, dict: PdfDict, g: WidgetGeom, minX: number, minY: number,
  color: RGB, fill: RGB | undefined, width: number,
): string | undefined {
  const contentsRaw = doc.resolve(dict.get('Contents'));
  if (!isString(contentsRaw)) return undefined;
  const contents = decodePdfText(contentsRaw.bytes);

  const daRaw = doc.resolve(dict.get('DA'));
  const da = isString(daRaw) ? parseDA(decodePdfText(daRaw.bytes)) : undefined;
  const fontSize = da !== undefined && da.size > 0 ? da.size : 12;
  const textColor: RGB = da !== undefined ? da.color : [0, 0, 0];

  const q = doc.resolve(dict.get('Q'));
  const align = q === 1 ? 'center' : q === 2 ? 'right' : 'left';

  // /RD is the padding from /Rect in to the text box: [left, top, right, bottom].
  const rd = numsOf(doc, dict.get('RD'));
  const [padL, padT, padR, padB] = rd.length === 4 ? rd : [0, 0, 0, 0];
  const boxW = g.w - padL - padR;
  const boxH = g.h - padT - padB;
  if (boxW <= 0 || boxH <= 0) return undefined;

  let body = `q 1 0 0 1 ${num(padL)} ${num(padB)} cm\n` +
    freeTextBoxBody(boxW, boxH, contents, fontSize, textColor, align, color, fill, width) +
    '\nQ\n';

  // A callout leader, when /CL is present, drawn in BBox space.
  const cl = numsOf(doc, dict.get('CL'));
  if (cl.length === 4 || cl.length === 6) {
    const p = toFormSpace(cl, minX, minY);
    body += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width || 1)} w\n`;
    body += `${num(p[0])} ${num(p[1])} m `;
    for (let i = 2; i < p.length; i += 2) body += `${num(p[i])} ${num(p[i + 1])} l `;
    body += 'S\n';
    const le = doc.resolve(dict.get('LE'));
    const ending = isName(le) ? (le.name as LineEnding) : 'OpenArrow';
    if (ending !== 'None') {
      const [dx, dy] = unitDir(p[2], p[3], p[0], p[1]);
      body += drawEnding(p[0], p[1], dx, dy, ending, Math.max(8, width * 3), color);
    }
  }
  return body;
}

/** Regenerate the /AP /N appearance for an existing annotation dict, from the
 *  properties the dict already carries.
 *
 *  Returns false when this subtype has no generator (/Text and /Stamp are
 *  viewer-drawn or carry their content only in an appearance we do not have;
 *  /Link, /Popup, /Sound and /FileAttachment likewise), or when the
 *  geometry is too degenerate or malformed to draw. In every false case the
 *  dict is left untouched, without an /AP — better an annotation with no
 *  appearance than one drawn from a guess. */
export function regenerateAppearance(doc: Document, dict: PdfDict): boolean {
  const sub = dict.get('Subtype');
  const subtype = isName(sub) ? sub.name : '';
  const g = widgetGeom(doc, dict);
  if (!g) return false;

  const rect = numsOf(doc, dict.get('Rect'));
  if (rect.length !== 4) return false;
  const minX = Math.min(rect[0], rect[2]);
  const minY = Math.min(rect[1], rect[3]);

  const color = colorOf(doc, dict.get('C')) ?? [0, 0, 0];
  const fill = colorOf(doc, dict.get('IC'));
  const width = widthOf(doc, dict);
  const ca = doc.resolve(dict.get('CA'));
  const opacity = typeof ca === 'number' && ca >= 0 && ca <= 1 ? ca : 1;

  let body: string | undefined;
  switch (subtype) {
    case 'Square':
      body = drawRect(g, color, fill, width);
      break;
    case 'Circle':
      body = drawEllipse(g, color, fill, width);
      break;
    case 'Highlight': case 'Underline': case 'StrikeOut': case 'Squiggly': {
      const quads = numsOf(doc, dict.get('QuadPoints'));
      if (quads.length === 0 || quads.length % 8 !== 0) return false;
      const qs = offsetQuads(quads, minX, minY);
      const draw = subtype === 'Highlight' ? drawHighlight
        : subtype === 'Underline' ? drawUnderline
        : subtype === 'StrikeOut' ? drawStrikeOut
        : drawSquiggly;
      body = draw(qs, color);
      break;
    }
    case 'Line':
      body = lineBody(doc, dict, minX, minY, color, width);
      break;
    case 'Polygon':
      body = polyBody(doc, dict, true, minX, minY, color, fill, width);
      break;
    case 'PolyLine':
      body = polyBody(doc, dict, false, minX, minY, color, undefined, width);
      break;
    case 'Ink':
      body = inkBody(doc, dict, minX, minY, color, width);
      break;
    case 'FreeText':
      body = freeTextBody(doc, dict, g, minX, minY, color, fill, width);
      break;
    case 'Caret': {
      const sy = doc.resolve(dict.get('Sy'));
      const symbol = isName(sy) && sy.name === 'P' ? 'paragraph' : 'none';
      const rd = numsOf(doc, dict.get('RD'));
      body = caretBody(g, color, symbol, rd.length === 4 ? rd : undefined);
      if (body === '') return false; // /RD left no room
      break;
    }
    default:
      return false;
  }

  if (body === undefined) return false;
  installShapeAP(doc, dict, g, body, opacity);
  return true;
}
