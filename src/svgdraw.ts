// SVG -> PDF content stream (issue 1gg0.3). Walks the XmlNode tree from xml.ts
// and emits operators, maintaining the q/Q state stack and collecting the names
// of anything it could not render. Pure of PDF plumbing: it imports no Document
// and allocates no objects — /ExtGState entries are DIRECT dicts placed in the
// Form XObject's own /Resources by svgembed.ts.
//
// Content is emitted in raw viewBox units with y still pointing DOWN. The flip
// to PDF's y-up happens once, in svgtransform.ts's placementMatrix.
import { parseXml, type XmlNode } from './xml.js';
import { num } from './pagecontent.js';
import { name, type PdfDict, type PdfObject } from './types.js';
import { IDENTITY, mul, invert, apply, type Matrix } from './text.js';
import {
  attrNum, parsePath, segsBBox, shapeSegs, subtreeBBox,
  type SvgSeg, type SegBBox, type TextMeasure,
} from './svgpath.js';

export { shapeSegs } from './svgpath.js';
import { INITIAL, resolveStyle, styleGetter, type Paint } from './svgstyle.js';
import { resolveMask, type MaskSpec } from './svgmask.js';
import {
  markerVertices, resolveMarker, markerMatrix, type MarkerSpec,
} from './svgmarker.js';
import {
  fitBox, parseTransform, parseViewBox, viewBoxFitDown, type ViewBox,
} from './svgtransform.js';
import { gradientPaint, type GradientPaint } from './svggradient.js';
import { resolvePattern, tileRect, tileMatrix } from './svgpattern.js';
import type { Rgb } from './svgstyle.js';
import {
  flattenText, layoutText, emitGlyphs, decorationOps, glyphsBBox,
  type SvgFontProvider, type FlatText, type PlacedGlyph, type TextPathSpec,
} from './svgtext.js';
import { measurePath, reverseMetrics, mapGlyphsToPath } from './svgtextpath.js';
import { canStretch, stretchGlyphs, type StretchedRun } from './svgtextstretch.js';
import {
  collectStyleText, parseStylesheet, resolveAll, type CssMap,
} from './svgcss.js';
import type { BuiltImage } from './imageembed.js';
import { decodeImage, decodePayload, imagePlacement, imageSize } from './svgimage.js';
import {
  classify, resolveFilter, type FastPath, type FilterPrim, type FilterSpec,
} from './svgfilter.js';
import {
  flipRows, makeSurface, runFilter, toSurface, surfaceImage, type Surface,
} from './svgfilterfx.js';
import { ctmScale, FLATTEN_TOL } from './strokegeom.js';
import type { ImageRgba } from './raster.js';

/** Allocates a content stream and returns its reference. svgembed.ts implements
 *  it, because a stream MUST be an indirect object — which this module,
 *  allocating nothing, cannot produce. Used for a PatternType 1 tile and for a
 *  luminosity mask group; mirrors SvgFontProvider, for the same reason. */
export interface SvgStreamSink {
  stream(dict: PdfDict, content: string): PdfObject;
}

/** Allocates an Image XObject (and its /SMask) and returns its reference.
 *  svgembed.ts implements it, because an Image XObject IS a stream and streams
 *  must be indirect objects. Mirrors SvgStreamSink, for the same reason. */
export interface SvgImageSink {
  image(built: BuiltImage): PdfObject;
}

/** Rasterize a Form XObject to RGBA. svgembed.ts implements it, because only it
 *  may allocate; mirrors SvgStreamSink and SvgImageSink, for the same reason.
 *
 *  Returns raster.ts's ImageRgba — straight-alpha sRGB bytes — NOT a Surface.
 *  The sink stays in the rasterizer's vocabulary; converting to premultiplied
 *  linear Float32 is the filter pipeline's job, and belongs on the pure side of
 *  the seam where it is testable without a Document.
 *
 *  The form's /BBox defines what is rendered: it maps onto exactly devW x devH
 *  pixels, so the sink makes no resolution policy of its own. */
export interface SvgRasterSink {
  rasterize(dict: PdfDict, content: string, devW: number, devH: number): ImageRgba | null;
}

/** The placement-dependent knobs. All optional: a pure unit test supplies none,
 *  and a <filter> there simply reports rather than rasterizing. */
export interface SvgDrawOptions {
  /** Points per user unit at the placement. Default 1. */
  deviceScale?: number;
  /** Resolution multiplier for a rasterized <filter>. Default 2. */
  filterScale?: number;
  raster?: SvgRasterSink;
  /** Caller-supplied bytes for an href the walker cannot decode itself. See
   *  decodeImage in svgimage.ts. */
  resolveImage?: (href: string) => Uint8Array | undefined;
}

/** What the walker produces: a content stream, the resources it needs, and the
 *  element names it could not render. */
export interface DrawResult {
  content: string;
  resources: PdfDict;
  skipped: string[];
  /** Distinct element names whose subtree was flattened to a bitmap, sorted.
   *  Not a fidelity loss like `skipped` — the content renders correctly — but
   *  it is resolution-bound, and its text is no longer extractable. */
  rasterized: string[];
}

/** Elements that render nothing and are not a fidelity loss when ignored.
 *  <style> is here because its rules are collected by a pre-pass before the
 *  walk; anything it could not honour is reported separately by drawSvg. */
const NON_RENDERING = new Set(['title', 'desc', 'metadata', 'style']);

/** Elements that define something for another element to reference, and render
 *  nothing where they sit. Reached in their own right only by the tree walk, so
 *  they draw nothing and are never reported. */
const DEFINITION = new Set([
  'clipPath', 'linearGradient', 'radialGradient', 'pattern', 'mask', 'marker', 'filter',
]);

/** Elements the walker handles itself rather than treating as unsupported. */
const STRUCTURAL = new Set([
  'svg', 'g', 'defs', 'use', 'symbol', 'text', 'image', ...DEFINITION,
]);

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

/** Emit path-construction operators for `segs`. */
export function emitSegs(segs: SvgSeg[], out: string[]): void {
  for (const s of segs) {
    if (s.op === 'M') out.push(`${num(s.args[0])} ${num(s.args[1])} m`);
    else if (s.op === 'L') out.push(`${num(s.args[0])} ${num(s.args[1])} l`);
    else if (s.op === 'C') out.push(`${s.args.map(num).join(' ')} c`);
    else out.push('h');
  }
}

/** A stable string for a PdfObject tree, used only for pattern equality.
 *  Patterns nest three dicts deep, so a field-by-field compare would be worse.
 *
 *  @internal Exported for tests: the ref branch is load-bearing but only
 *  reachable through a tiling pattern, which makes it easy to break silently. */
export function __canon(v: PdfObject): string {
  if (v instanceof Map) return `<${[...v].map(([k, x]) => `${k}:${__canon(x)}`).join(',')}>`;
  if (Array.isArray(v)) return `[${v.map(__canon).join(',')}]`;
  if (v !== null && typeof v === 'object' && 'kind' in v) {
    // A ref would otherwise fall through to String(v) === "[object Object]",
    // making EVERY reference canonicalize identically.
    if (v.kind === 'ref') return `R${v.num}.${v.gen}`;
    if (v.kind === 'name') return `/${v.name}`;
  }
  return String(v);
}

class Emitter {
  readonly out: string[] = [];
  skipped = new Set<string>();
  readonly extg: PdfDict = new Map<string, PdfObject>();
  /** id -> element, for use/clipPath resolution. */
  ids = new Map<string, XmlNode>();
  /** ids currently being expanded through <use>, to break reference cycles. */
  active = new Set<string>();
  /** Pattern ids currently being expanded, likewise. Shared with every child,
   *  so a cycle that runs through a tile is caught too. */
  activePatterns = new Set<string>();
  /** Mask ids currently being expanded, to break reference cycles. Shared with
   *  every child, so a cycle running through a mask's own content is caught.
   *  Mirrors activePatterns. */
  activeMasks = new Set<string>();
  /** Marker ids currently being expanded, to break reference cycles — a marker
   *  whose own content carries the same marker. Mirrors activePatterns. */
  activeMarkers = new Set<string>();
  /** Element names flattened to a bitmap. Shared with every child, like
   *  `skipped`: a rasterization inside a tile is still one. */
  rasterized = new Set<string>();
  /** Supplied by svgembed.ts when a filter can be rasterized at all. Absent in
   *  a pure unit test, where a filtered element reports instead. */
  raster?: SvgRasterSink;
  /** Points per user unit at the placement, times the filter resolution
   *  multiplier. Only the filter path reads it. */
  filterPx = 2;
  /** Supplied by the caller through AddSVGOptions; see decodeImage. */
  resolveImage?: (href: string) => Uint8Array | undefined;
  /** `${id}|${strokeWidth}` -> the marker form's ref. The stroke scale is baked
   *  into the placement, not the form, so one form serves every vertex of one
   *  element — but an element with a different stroke width needs its own. */
  markerForms = new Map<string, PdfObject>();
  /** How many nested <image> SVG payloads deep this emitter is. A data: URI
   *  cannot reference itself, so nesting is already bounded by the input's
   *  length; this bounds pathological input and stack growth, not a cycle. */
  svgDepth = 0;
  /** `${href}|${viewBox}` -> the nested SVG's form ref, shared walk-wide like
   *  `images`. The fit lives in the placing `cm`, not in the form, so one form
   *  serves every placement of the same payload at the same viewBox. */
  svgForms = new Map<string, PdfObject>();
  /** Supplied by svgembed.ts: only it may allocate a stream. */
  streams!: SvgStreamSink;
  /** Image XObjects THIS stream referenced: key -> ref. Per-stream, like `pat`. */
  readonly xobj: PdfDict = new Map<string, PdfObject>();
  /** href -> the ref and intrinsic size, walk-wide so a repeated data: URI is
   *  embedded once. Shared with every child: /Resources are per-stream but refs
   *  are document-wide. Keyed by href text, so two spellings of identical bytes
   *  still embed twice — Optimize's dedup pass is what collapses those. */
  images = new Map<string, { ref: PdfObject; w: number; h: number }>();
  /** canonical (alpha pattern + box) -> the mask group's ref, walk-wide so two
   *  shapes sharing one ramp allocate one group. Shared with every child:
   *  /Resources are per-stream but refs are document-wide. Mirrors `images`. */
  masks = new Map<string, PdfObject>();
  /** Supplied by svgembed.ts: only it may allocate an image stream. */
  imageSink!: SvgImageSink;
  /** Test-only: the CTM in effect at each painted shape, in paint order. */
  ctms: Matrix[] | null = null;
  readonly pat: PdfDict = new Map<string, PdfObject>();
  /** canonical pattern text -> resource key, so two shapes sharing one gradient
   *  under one placement register one pattern. Mirrors gsKey's intent, but the
   *  dicts are nested, so equality is taken on a canonical serialization. */
  private readonly patKeys = new Map<string, string>();
  /** The viewport, for userSpaceOnUse percentage resolution. */
  viewport: ViewBox = { minX: 0, minY: 0, w: 0, h: 0 };
  /** Supplied by svgembed.ts, which is the only module that may allocate the
   *  font objects a face needs. */
  fonts!: SvgFontProvider;
  /** Per-element CSS declarations, from the whole-tree pre-pass. Empty when the
   *  document carries no <style>. */
  css: CssMap = new Map();
  /** Font resource keys this stream's content referenced. A tile builds its own
   *  /Font from these; the provider's dict is document-wide. */
  readonly usedFonts = new Set<string>();
  /** Union of everything this emitter painted, in its own space. Accumulated
   *  only for a tile that asked for overflow: visible, where /BBox must cover
   *  the ink rather than the cell — it costs an eager bbox per shape. */
  ink: SegBBox | null = null;
  wantInk = false;

  /** Fold one painted box, under `m`, into the ink union. */
  addInk(b: SegBBox | null, m: Matrix): void {
    if (!this.wantInk || !b) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of [b.x, b.x + b.w]) for (const y of [b.y, b.y + b.h]) {
      const px = m[0] * x + m[2] * y + m[4];
      const py = m[1] * x + m[3] * y + m[5];
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    const cur = this.ink;
    if (cur === null) { this.ink = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; return; }
    const nx = Math.min(cur.x, x0), ny = Math.min(cur.y, y0);
    this.ink = {
      x: nx, y: ny,
      w: Math.max(cur.x + cur.w, x1) - nx,
      h: Math.max(cur.y + cur.h, y1) - ny,
    };
  }

  /** A fresh emitter for a nested content stream — a pattern tile.
   *
   *  Indexes, the font provider, the sink and both cycle guards are SHARED; the
   *  output buffer and every resource map are FORKED, because a tile's stream
   *  has its own /Resources and cannot see the enclosing form's. `skipped` is
   *  shared too: a loss inside a tile is still a loss. */
  child(): Emitter {
    const c = new Emitter();
    c.ids = this.ids;
    c.css = this.css;
    c.fonts = this.fonts;
    c.streams = this.streams;
    c.imageSink = this.imageSink;
    c.images = this.images;
    c.masks = this.masks;
    c.viewport = this.viewport;
    c.skipped = this.skipped;
    c.active = this.active;
    c.activePatterns = this.activePatterns;
    c.activeMasks = this.activeMasks;
    c.activeMarkers = this.activeMarkers;
    c.markerForms = this.markerForms;
    c.rasterized = this.rasterized;
    c.raster = this.raster;
    c.filterPx = this.filterPx;
    // child() forks for a pattern tile, a marker, a mask and a filter subtree.
    // Without this copy the resolver works at the top level and is silently
    // absent in all four.
    c.resolveImage = this.resolveImage;
    c.svgDepth = this.svgDepth;
    c.svgForms = this.svgForms;
    return c;
  }

  /** Fork for a nested SVG DOCUMENT — an <image> whose payload is SVG — not for
   *  another stream of this one. Everything id-keyed starts FRESH: `ids` and
   *  `css` belong to the payload; `markerForms` is keyed by id, so a shared map
   *  would draw an outer #arrow for a nested one; and the four cycle guards
   *  would let an outer id in flight suppress an unrelated nested element.
   *
   *  Sinks, fonts, the two content-addressed caches and both report sets stay
   *  shared — a loss inside a nested SVG is still a loss in the outer result. */
  subdoc(viewport: ViewBox): Emitter {
    const c = new Emitter();
    c.fonts = this.fonts;
    c.streams = this.streams;
    c.imageSink = this.imageSink;
    c.images = this.images;
    c.masks = this.masks;
    c.svgForms = this.svgForms;
    c.skipped = this.skipped;
    c.rasterized = this.rasterized;
    c.raster = this.raster;
    c.filterPx = this.filterPx;
    c.resolveImage = this.resolveImage;
    c.viewport = viewport;
    c.svgDepth = this.svgDepth + 1;
    return c;
  }

  // The two members that make Emitter a svgtext.ts TextSink, structurally.
  push(op: string): void { this.out.push(op); }
  setPaint(p: Paint, bbox: SegBBox | null, ctm: Matrix): { fill: boolean; stroke: boolean } {
    // canSplit stays false: emitGlyphs would have to show every run twice to
    // paint fill and stroke as separate operations.
    const r = resolvePaint(this, p, bbox, ctm);
    const pass = r.passes[0];
    if (pass) for (const op of pass.ops) this.out.push(op);
    return { fill: r.fill, stroke: r.stroke };
  }

  /** Register `d`, reusing an identical pattern; returns its resource key. */
  patKey(d: PdfObject): string {
    const k = __canon(d);
    const hit = this.patKeys.get(k);
    if (hit !== undefined) return hit;
    const key = `P${this.pat.size}`;
    this.pat.set(key, d);
    this.patKeys.set(k, key);
    return key;
  }

  /** Register `r` in THIS stream's /XObject; returns its resource key. Identity
   *  comparison is exact because `images` hands back the same ref object.
   *
   *  `prefix` only names the key — /XObject holds images and Form XObjects in
   *  one dictionary, so the counter is shared and the names stay unique either
   *  way. It exists so a masked element's group reads as Fm rather than Im in
   *  the stream. */
  xobjKey(r: PdfObject, prefix: 'Im' | 'Fm' = 'Im'): string {
    for (const [k, v] of this.xobj) if (v === r) return k;
    const key = `${prefix}${this.xobj.size}`;
    this.xobj.set(key, r);
    return key;
  }

  /** canonical ExtGState text -> resource key. A (ca, CA) pair no longer
   *  identifies a state on its own, now that one may carry a soft mask. */
  private readonly gsKeys = new Map<string, string>();

  /** Reuse one /ExtGState per (ca, CA, soft mask, subtype); returns its resource
   *  key. A (ca, CA) pair no longer identifies a state on its own, now that one
   *  may carry a soft mask — and the subtype is part of that identity, since a
   *  luminosity and an alpha mask over the same group are different states. */
  gsKey(
    ca: number, CA: number, smask?: PdfObject,
    smaskType: 'Luminosity' | 'Alpha' = 'Luminosity',
  ): string {
    const d: PdfDict = new Map<string, PdfObject>([
      ['Type', name('ExtGState')], ['ca', ca], ['CA', CA],
    ]);
    if (smask !== undefined)
      d.set('SMask', new Map<string, PdfObject>([
        ['S', name(smaskType)], ['G', smask],
      ]));
    const k = __canon(d);
    const hit = this.gsKeys.get(k);
    if (hit !== undefined) return hit;
    const key = `GS${this.extg.size}`;
    this.extg.set(key, d);
    this.gsKeys.set(k, key);
    return key;
  }
}

/** Index every element carrying an id, so use/clipPath can resolve references. */
function indexIds(n: XmlNode, into: Map<string, XmlNode>): void {
  const id = n.attrs.get('id');
  if (id !== undefined && !into.has(id)) into.set(id, n);
  for (const c of n.children) indexIds(c, into);
}

/** Resolve a `url(#id)` paint reference to a gradient paint, or null when it is
 *  not a gradient element (which the caller reports, as it does today). */
function gradientFor(
  e: Emitter, id: string | null, bbox: SegBBox | null, ctm: Matrix,
): GradientPaint | null {
  if (id === null) return null;
  const node = e.ids.get(id);
  if (!node || (node.name !== 'linearGradient' && node.name !== 'radialGradient')) return null;
  const gp = gradientPaint(node, e.ids, bbox, e.viewport, ctm, e.css);
  if (gp.report) e.skipped.add(node.name);
  return gp;
}

/** One painting operation: the operators that set it up, and which of fill and
 *  stroke it performs. Normally there is exactly one. A luminosity /SMask
 *  applies to a whole painting operation, so a masked fill beside an unmasked
 *  stroke needs two. */
export interface PaintPass {
  fill: boolean;
  stroke: boolean;
  /** Colour, pattern, alpha and stroke-parameter operators, in order. */
  ops: string[];
}

/** The paint decision for one element: whether each of fill and stroke happens
 *  at all, and the passes that perform them. */
export interface PaintOps {
  fill: boolean;
  stroke: boolean;
  passes: PaintPass[];
}

/** Build the tiling pattern for one `<pattern>` element, painting its children
 *  into a nested content stream. Returns null when the pattern paints nothing,
 *  which SVG treats as an outcome rather than a loss. */
function tilingFor(
  e: Emitter, node: XmlNode, bbox: SegBBox | null, ctm: Matrix,
): PdfObject | null {
  const id = node.attrs.get('id') ?? '';
  if (id !== '' && e.activePatterns.has(id)) {
    e.skipped.add('pattern');                 // reference cycle
    return null;
  }
  const { attrs, content } = resolvePattern(node, e.ids);
  if (content.children.length === 0) return null;

  const obb = (attrs.get('patternUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  const rect = tileRect(attrs, obb, bbox, e.viewport);
  if (!rect) return null;
  const { matrix, content: cm } = tileMatrix(attrs, rect, obb, bbox, ctm);

  const sub = e.child();
  sub.wantInk = (attrs.get('overflow') ?? '').trim() === 'visible';
  if (id !== '') sub.activePatterns.add(id);
  const hasCm = cm.some((v, i) => v !== IDENTITY[i]);
  if (hasCm) { sub.out.push('q'); sub.out.push(`${cm.map(num).join(' ')} cm`); }
  for (const c of content.children)
    walk(sub, c, INITIAL, false, hasCm ? mul(cm, [...IDENTITY]) : [...IDENTITY]);
  if (hasCm) sub.out.push('Q');
  if (id !== '') sub.activePatterns.delete(id);

  // overflow: visible means content may cross tile boundaries. PDF always
  // clips a cell to /BBox, so the box grows to cover the ink while /XStep and
  // /YStep stay at the tile size -- adjacent cells then overlap and spill.
  let bx = 0, by = 0, bw = rect.w, bh = rect.h;
  if (sub.wantInk && sub.ink) {
    bx = Math.min(0, sub.ink.x);
    by = Math.min(0, sub.ink.y);
    bw = Math.max(rect.w, sub.ink.x + sub.ink.w) - bx;
    bh = Math.max(rect.h, sub.ink.y + sub.ink.h) - by;
  }

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Pattern')],
    ['PatternType', 1],
    ['PaintType', 1],
    ['TilingType', 1],
    ['BBox', [bx, by, bx + bw, by + bh]],
    ['XStep', rect.w],
    ['YStep', rect.h],
    ['Resources', buildResources(sub)],
    ['Matrix', [...matrix]],
  ]);
  return e.streams.stream(dict, sub.out.join('\n'));
}

/** A resolved url() paint. Unifies the two paint servers so resolvePaint has
 *  one shape to consume: the Pattern resource is already REGISTERED and carried
 *  as a key, since a tile is a ref and a shading is a dict. */
type ServerPaint =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgb; opacity: number }
  | { kind: 'pattern'; key: string; opacity: number;
      /** The grayscale alpha ramp, when the gradient's stop alphas differ. */
      alphaPattern: PdfDict | null;
      /** The element name to report if the ramp has to be dropped. */
      elem: string };

/** Resolve a url() reference to a gradient or a tiling pattern. Returns null
 *  when it names neither, which leaves the element's own colour in play. */
function paintServer(
  e: Emitter, id: string | null, bbox: SegBBox | null, ctm: Matrix,
): ServerPaint | null {
  if (id === null) return null;
  const node = e.ids.get(id);
  if (!node) return null;
  if (node.name === 'pattern') {
    const t = tilingFor(e, node, bbox, ctm);
    return t === null ? { kind: 'none' }
      : { kind: 'pattern', key: e.patKey(t), opacity: 1, alphaPattern: null, elem: 'pattern' };
  }
  const g = gradientFor(e, id, bbox, ctm);
  if (!g) return null;
  if (g.kind === 'pattern')
    return {
      kind: 'pattern', key: e.patKey(g.pattern), opacity: g.opacity,
      alphaPattern: g.alphaPattern, elem: node.name,
    };
  if (g.kind === 'solid')
    return { kind: 'solid', color: g.color, opacity: g.opacity };
  return { kind: 'none' };
}

/** The luminosity mask group for one alpha ramp: a transparency-group Form
 *  XObject painting `box` with the ramp's grayscale twin.
 *
 *  Its /Matrix is identity, so its content space is ELEMENT USER SPACE — the
 *  group is rendered under the CTM that was current when its `gs` ran, and
 *  `walk` emits the element's `cm` before the paint. That is exactly why
 *  `alphaPattern` carries no CTM factor.
 *
 *  A rectangle, not the shape's own geometry: the mask is never sampled outside
 *  the ink, so over-covering is free and the group needs no stroke parameters,
 *  no fill rule, and no fonts. For the same reason /BBox may be generous. */
function maskGroup(e: Emitter, alphaPattern: PdfDict, box: SegBBox): PdfObject {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box.x, box.y, box.x + box.w, box.y + box.h]],
    ['Matrix', [...IDENTITY]],
    ['Group', new Map<string, PdfObject>([
      ['Type', name('Group')],
      ['S', name('Transparency')],
      ['CS', name('DeviceGray')],
    ])],
    ['Resources', new Map<string, PdfObject>([
      ['Pattern', new Map<string, PdfObject>([['P0', alphaPattern]])],
    ])],
  ]);
  const key = __canon(dict);
  const hit = e.masks.get(key);
  if (hit !== undefined) return hit;
  const content = [
    '/Pattern cs', '/P0 scn',
    `${num(box.x)} ${num(box.y)} ${num(box.w)} ${num(box.h)} re`, 'f',
  ].join('\n');
  const r = e.streams.stream(dict, content);
  e.masks.set(key, r);
  return r;
}

/** Paint `body` into its own transparency-group Form XObject and return its ref.
 *
 *  A masked element cannot simply add an /SMask to its `gs`: one ExtGState holds
 *  ONE soft mask, and a varying-alpha gradient already claims that slot
 *  (resolvePaint). Grouping sidesteps that — the mask attaches to the `Do`, and
 *  the gradient's own mask stays inside, untouched.
 *
 *  `/BBox` is the mask region, which is exact rather than a crop: SVG 1.1 §14.4
 *  makes the element fully transparent outside the region regardless, so
 *  clipping the group to it removes nothing that would have been visible. That is
 *  also why this needs no bbox union of its own.
 *
 *  `/Matrix` is identity, so the group's content space is the ELEMENT's user
 *  space — `walk` has already emitted the element's own `cm`. Mirrors maskGroup's
 *  reasoning. */
function groupForm(e: Emitter, box: SegBBox, body: (sub: Emitter) => void): PdfObject {
  const g = e.child();
  body(g);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box.x, box.y, box.x + box.w, box.y + box.h]],
    ['Matrix', [...IDENTITY]],
    ['Group', new Map<string, PdfObject>([
      ['Type', name('Group')],
      ['S', name('Transparency')],
    ])],
    ['Resources', buildResources(g)],
  ]);
  return e.streams.stream(dict, g.out.join('\n'));
}

/** The viewport rectangle in the element's OWN user space: the viewport corners
 *  mapped back through `ctm`, axis-aligned. This is the /BBox for an opacity
 *  group.
 *
 *  It never crops. svgembed.ts already sets the outer form's /BBox to the
 *  viewport, so ink outside this box is invisible whatever the box says. The
 *  tempting alternative — subtreeBBox inflated by the stroke width — is
 *  fill-geometry-only and can report `complete: false`, and markers, filter
 *  regions and miter joins all paint outside it; every future primitive that
 *  paints past the fill box would become a silent cropping bug, and a crop
 *  inside an opacity group is invisible until someone builds the right fixture.
 *  The cost of the loose box is a larger offscreen buffer at RENDER time, not a
 *  larger file: a /BBox is four numbers.
 *
 *  null when `ctm` is singular — the content has collapsed to no area, so the
 *  caller folds and nothing is visible either way. */
function viewportBox(e: Emitter, ctm: Matrix): SegBBox | null {
  let inv: Matrix;
  try { inv = invert(ctm); } catch { return null; }
  const vb = e.viewport;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const x of [vb.minX, vb.minX + vb.w]) for (const y of [vb.minY, vb.minY + vb.h]) {
    const [px, py] = apply(inv, x, y);
    x0 = Math.min(x0, px); x1 = Math.max(x1, px);
    y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)
      || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Whether `opacity` on this element must go through a transparency group.
 *
 *  Folding the alpha into the element's own paints is exact whenever it
 *  performs exactly ONE paint operation: with one operation there is nothing
 *  for the reduced alpha to composite against twice. Everything else overlaps
 *  itself somewhere — a container's children with each other, a stroke with its
 *  own fill along the boundary, a marker with the path it sits on, a glyph with
 *  its neighbour and with its own decoration.
 *
 *  Keeping the fold for the single-operation cases is not just cheaper: it is
 *  what stops every ordinary faded shape in every SVG allocating a Form XObject.
 *
 *  The fill-and-stroke test over-approximates on purpose. Answering "both" when
 *  only one channel paints costs a redundant group and looks identical;
 *  answering "one" when both paint is a wrong pixel. Any future paint channel
 *  belongs on the conservative side of that asymmetry. */
function needsOpacityGroup(n: XmlNode, p: Paint): boolean {
  if (n.name === 'image') return false;         // one Do — the fold is exact
  if (n.name === 'text') return true;           // glyphs and decoration overlap
  if (!SHAPES.has(n.name)) return true;         // g / svg / use / symbol
  // Markers apply to these four only (SVG 1.1 §11.6.2); mirroring walk's own
  // rule keeps a faded <rect> from grouping over an inherited marker-* property.
  if ((n.name === 'path' || n.name === 'line'
       || n.name === 'polyline' || n.name === 'polygon')
      && (p.markerStart !== null || p.markerMid !== null || p.markerEnd !== null))
    return true;
  // `fill` does not apply to <line> (SVG 1.1 §11.3), which is why walk paints it
  // with fill forced off. Reading the inherited black here would group every
  // faded line for a fill it never draws.
  const fills = n.name !== 'line' && (p.fill !== null || p.fillRef !== null);
  const strokes = (p.stroke !== null || p.strokeRef !== null) && p.strokeWidth > 0;
  return fills && strokes;
}

/** The soft-mask group for one `<mask>` element: a transparency group holding
 *  the mask's children, painted in the masked element's user space.
 *
 *  /CS is DeviceGray for a luminosity mask — the group is composited against a
 *  black backdrop (/BC [0], the DeviceGray default), which is exactly what makes
 *  this exact: SVG's mask value is luminance × alpha, and compositing over black
 *  scales colour by alpha, so luminance(C*a) = luminance(C)*a. An alpha mask
 *  reads the alpha channel directly and needs a colour group, so it gets
 *  DeviceRGB.
 *
 *  Returns null when the mask paints nothing, which SVG treats as "mask
 *  everything out" rather than as a loss — but a fully transparent element is
 *  indistinguishable from a dropped one, so the caller reports it. */
function maskFor(e: Emitter, node: XmlNode, spec: MaskSpec): PdfObject | null {
  const id = node.attrs.get('id') ?? '';
  if (id !== '' && e.activeMasks.has(id)) return null;      // reference cycle

  const g = e.child();
  if (id !== '') g.activeMasks.add(id);
  const hasCm = spec.content.some((v, i) => v !== IDENTITY[i]);
  if (hasCm) { g.out.push('q'); g.out.push(`${spec.content.map(num).join(' ')} cm`); }
  for (const c of node.children)
    walk(g, c, INITIAL, false, hasCm ? mul(spec.content, [...IDENTITY]) : [...IDENTITY]);
  if (hasCm) g.out.push('Q');
  if (id !== '') g.activeMasks.delete(id);
  if (g.out.length === 0) return null;

  const box = spec.region;
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box.x, box.y, box.x + box.w, box.y + box.h]],
    ['Matrix', [...IDENTITY]],
    ['Group', new Map<string, PdfObject>([
      ['Type', name('Group')],
      ['S', name('Transparency')],
      ['CS', name(spec.type === 'Alpha' ? 'DeviceRGB' : 'DeviceGray')],
    ])],
    ['Resources', buildResources(g)],
  ]);
  const key = __canon(dict);
  const hit = e.masks.get(key);
  if (hit !== undefined) return hit;
  const r = e.streams.stream(dict, g.out.join('\n'));
  e.masks.set(key, r);
  return r;
}

/** The TextMeasure subtreeBBox needs. svgtext.ts's layout is already here, but
 *  it needs the font provider, which is why this cannot live in svgpath.ts.
 *
 *  Seeded with INITIAL, never with a resolved paint. The box being measured is
 *  objectBoundingBox, which is fill geometry only — subtreeBBox gives shapes no
 *  stroke inflation either — so no Paint field may reach it, and an inert seed
 *  is the honest way to say so. Handing over the caller's `paint` would apply
 *  the <text> node's own attributes twice, the double-resolve fixed at the
 *  painting call site; handing over its `parent` would be right only when the
 *  filtered/masked element IS the <text>, since subtreeBBox also reaches <text>
 *  nodes deeper in the subtree whose inherited paint it does not track. Nothing
 *  here is a substitute for that tracking: anything that ever makes this box
 *  paint-dependent (stroke inflation is the obvious candidate, and would be a
 *  spec violation) must thread paint through subtreeBBox, not seed this call. */
function textMeasure(e: Emitter): TextMeasure {
  return (n) => glyphsBBox(layoutText(flattenText(n, INITIAL, e.fonts, 16, e.css)));
}

/** Resolve `p` over `bbox` into paint operators. Shared by paintShape and the
 *  text branch, so gradients reach both without the pattern registration being
 *  written twice.
 *
 *  Returns the operators rather than pushing them: a caller must be able to
 *  learn that nothing paints WITHOUT having already emitted a `q`. Pattern and
 *  /ExtGState keys are still registered on `e` as a side effect, which is why
 *  this takes the Emitter at all. */
export function resolvePaint(
  e: Emitter, p: Paint, bbox: SegBBox | null, ctm: Matrix, canSplit = false,
): PaintOps {
  const fg = p.fillRef !== null ? paintServer(e, p.fillRef, bbox, ctm) : null;
  const sg = p.strokeRef !== null ? paintServer(e, p.strokeRef, bbox, ctm) : null;

  const doFill = fg ? fg.kind !== 'none' : p.fill !== null;
  const doStroke = (sg ? sg.kind !== 'none' : p.stroke !== null) && p.strokeWidth > 0;
  if (!doFill && !doStroke) return { fill: false, stroke: false, passes: [] };

  // A uniform stop-opacity multiplies into the alpha the element already had.
  const gAlpha = (g: ServerPaint | null): number => (g && g.kind !== 'none' ? g.opacity : 1);
  const ca = doFill ? p.fillOpacity * gAlpha(fg) : 1;
  const CA = doStroke ? p.strokeOpacity * gAlpha(sg) : 1;

  const fillPaint: string[] = [];
  if (doFill) {
    if (fg && fg.kind === 'pattern') fillPaint.push('/Pattern cs', `/${fg.key} scn`);
    else if (fg && fg.kind === 'solid') fillPaint.push(`${fg.color.map(num).join(' ')} rg`);
    else fillPaint.push(`${p.fill!.map(num).join(' ')} rg`);
  }
  const strokePaint: string[] = [];
  if (doStroke) {
    if (sg && sg.kind === 'pattern') strokePaint.push('/Pattern CS', `/${sg.key} SCN`);
    else if (sg && sg.kind === 'solid') strokePaint.push(`${sg.color.map(num).join(' ')} RG`);
    else strokePaint.push(`${p.stroke!.map(num).join(' ')} RG`);
    strokePaint.push(`${num(p.strokeWidth)} w`);
    if (p.lineCap !== 0) strokePaint.push(`${p.lineCap} J`);
    if (p.lineJoin !== 0) strokePaint.push(`${p.lineJoin} j`);
    if (p.miterLimit !== 4) strokePaint.push(`${num(p.miterLimit)} M`);
    if (p.dash.length > 0)
      strokePaint.push(`[${p.dash.map(num).join(' ')}] ${num(p.dashOffset)} d`);
  }

  // A varying alpha ramp cannot fold into /ca: it becomes a luminosity /SMask
  // over the shape's box. Built lazily, so a path that rejects the mask
  // allocates nothing.
  const ramp = (g: ServerPaint | null): PdfDict | null =>
    (g !== null && g.kind === 'pattern' ? g.alphaPattern : null);
  const fillRamp = doFill ? ramp(fg) : null;
  const strokeRamp = doStroke ? ramp(sg) : null;
  // Two calls to gradientPaint build two distinct dicts for one gradient, so
  // sameness is structural, not identity.
  const same = fillRamp === strokeRamp
    || (fillRamp !== null && strokeRamp !== null && __canon(fillRamp) === __canon(strokeRamp));

  // A stroke reaches strokeWidth * miterLimit / 2 past the path at a miter tip;
  // inflating the mask box by that is an exact upper bound, and costs nothing.
  const grow = (p.strokeWidth * Math.max(1, p.miterLimit)) / 2;
  const gsOps = (a: number, A: number, r: PdfDict | null, by: number): string[] => {
    const sm = r !== null && bbox !== null
      ? maskGroup(e, r,
          { x: bbox.x - by, y: bbox.y - by, w: bbox.w + 2 * by, h: bbox.h + 2 * by })
      : undefined;
    if (a >= 1 && A >= 1 && sm === undefined) return [];
    return [`/${e.gsKey(a, A, sm)} gs`];
  };

  // One soft mask covers a whole painting operation, so a masked fill beside a
  // differently-masked (or unmasked) stroke needs two passes.
  if (canSplit && doFill && doStroke && !same)
    return {
      fill: true,
      stroke: true,
      passes: [
        { fill: true, stroke: false, ops: [...gsOps(ca, 1, fillRamp, 0), ...fillPaint] },
        { fill: false, stroke: true, ops: [...gsOps(1, CA, strokeRamp, grow), ...strokePaint] },
      ],
    };

  // Un-splittable — a text run, where splitting would show every glyph twice.
  // Applying either ramp would wrongly mask the other paint, so drop both and
  // report, exactly as every varying ramp did before the mask existed.
  let mask = fillRamp ?? strokeRamp;
  if (doFill && doStroke && !same) {
    mask = null;
    const src = fillRamp !== null ? fg : sg;
    if (src !== null && src.kind === 'pattern') e.skipped.add(src.elem);
  }
  return {
    fill: doFill,
    stroke: doStroke,
    passes: [{
      fill: doFill,
      stroke: doStroke,
      ops: [...gsOps(ca, CA, mask, doStroke ? grow : 0), ...fillPaint, ...strokePaint],
    }],
  };
}

/** Paint a shape's segments with `p`, emitting only the operators it needs.
 *
 *  One q/Q per pass: a luminosity /SMask covers a whole painting operation, so a
 *  masked fill and a differently-masked stroke must not share one. `B` is
 *  defined as `f` then `S`, so splitting is visually identical. */
function paintShape(e: Emitter, segs: SvgSeg[], p: Paint, ctm: Matrix): void {
  if (segs.length === 0) return;

  // The bbox is only ever needed by a gradient, so it is computed lazily even
  // though objectBoundingBox — the default — makes that the common path.
  let box: SegBBox | null | undefined;
  const bbox = (): SegBBox | null => (box === undefined ? (box = segsBBox(segs)) : box);

  const { fill: doFill, stroke: doStroke, passes } =
    resolvePaint(e, p, p.fillRef !== null || p.strokeRef !== null ? bbox() : null, ctm, true);
  if (!doFill && !doStroke) return;
  if (e.ctms) e.ctms.push(ctm);
  e.addInk(bbox(), ctm);

  const eo = p.fillRule === 'evenodd' ? '*' : '';
  for (const pass of passes) {
    e.out.push('q');
    for (const op of pass.ops) e.out.push(op);
    emitSegs(segs, e.out);
    e.out.push(pass.fill && pass.stroke ? `B${eo}` : pass.fill ? `f${eo}` : 'S');
    e.out.push('Q');
  }
}

/** The Form XObject for one `<marker>`, built once per (marker, stroke width).
 *
 *  NOT a transparency group: a marker composites like any other content, so it
 *  needs none of groupForm's machinery. `/BBox` carries the overflow clip, which
 *  is why no `W n` is emitted inside.
 *
 *  Marker content does not inherit from the referencing element, so it walks from
 *  INITIAL — exactly as a pattern tile does. */
function markerFormFor(
  e: Emitter, node: XmlNode, spec: MarkerSpec, strokeWidth: number,
): PdfObject | null {
  const id = node.attrs.get('id') ?? '';
  if (id !== '' && e.activeMarkers.has(id)) return null;      // reference cycle
  const cacheKey = `${id}|${spec.scaleByStroke ? strokeWidth : 1}`;
  const hit = id === '' ? undefined : e.markerForms.get(cacheKey);
  if (hit !== undefined) return hit;

  const g = e.child();
  // PDF always clips a form to its /BBox, so overflow: visible has to grow the
  // box to cover the ink rather than simply not emitting a clip. Same problem
  // and same answer as a <pattern overflow="visible"> tile.
  g.wantInk = spec.clip === null;
  if (id !== '') g.activeMarkers.add(id);
  for (const c of node.children) walk(g, c, INITIAL, false, [...IDENTITY]);
  if (id !== '') g.activeMarkers.delete(id);
  if (g.out.length === 0) return null;

  // The box is in the form's own space, which is PRE-fit: markerMatrix composes
  // spec.content outside it, so a viewBox marker's content is in viewBox units.
  const box = spec.clip ?? g.ink ?? { x: 0, y: 0, w: spec.w, h: spec.h };
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box.x, box.y, box.x + box.w, box.y + box.h]],
    ['Matrix', [...IDENTITY]],
    ['Resources', buildResources(g)],
  ]);
  const r = e.streams.stream(dict, g.out.join('\n'));
  if (id !== '') e.markerForms.set(cacheKey, r);
  return r;
}

/** Paint the markers for one shape, after its own ink and in the same q/Q scope,
 *  so the element's transform applies and they sit above it. */
function paintMarkers(e: Emitter, segs: SvgSeg[], p: Paint, ctm: Matrix): void {
  if (p.markerStart === null && p.markerMid === null && p.markerEnd === null) return;
  if (segs.length === 0) return;

  const byKind = { start: p.markerStart, mid: p.markerMid, end: p.markerEnd };
  // Resolve each distinct id once, so a missing target is reported once.
  const forms = new Map<string, { spec: MarkerSpec; ref: PdfObject } | null>();
  const formFor = (id: string): { spec: MarkerSpec; ref: PdfObject } | null => {
    const seen = forms.get(id);
    if (seen !== undefined) return seen;
    let out: { spec: MarkerSpec; ref: PdfObject } | null = null;
    const node = e.ids.get(id);
    if (!node || node.name !== 'marker') {
      e.skipped.add('url()');
    } else {
      const spec = resolveMarker(node);
      const ref = spec ? markerFormFor(e, node, spec, p.strokeWidth) : null;
      if (spec && ref) out = { spec, ref };
      else e.skipped.add('marker');
    }
    forms.set(id, out);
    return out;
  };

  for (const v of markerVertices(segs)) {
    const id = byKind[v.kind];
    if (id === null) continue;
    const f = formFor(id);
    if (!f) continue;
    const m = markerMatrix(f.spec, v, p.strokeWidth);
    e.out.push('q');
    e.out.push(`${m.map(num).join(' ')} cm`);
    e.out.push(`/${e.xobjKey(f.ref, 'Fm')} Do`);
    e.out.push('Q');
    if (e.ctms) e.ctms.push(mul(m, ctm));
  }
}

/** The id in a `url(#id)` value, or undefined. */
function urlRef(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^url\(\s*#([^)\s]+)\s*\)$/.exec(v.trim());
  return m ? m[1] : undefined;
}

/** Emit the geometry of a <clipPath> followed by `W n`. Returns false when the
 *  reference does not resolve, in which case the caller draws unclipped rather
 *  than dropping the content. */
function emitClip(e: Emitter, node: XmlNode): boolean {
  let any = false;
  let evenOdd = false;
  for (const c of node.children) {
    if (!SHAPES.has(c.name)) continue;
    const { segs } = shapeSegs(c);
    if (segs.length === 0) continue;
    // A clip child's own transform still applies to the clip geometry.
    const tf = parseTransform(c.attrs.get('transform'));
    const hasTf = tf.some((v, i) => v !== IDENTITY[i]);
    if (hasTf) { e.out.push('q'); e.out.push(`${tf.map(num).join(' ')} cm`); }
    emitSegs(segs, e.out);
    if (hasTf) e.out.push('Q');
    // clip-rule is a CSS property too, and inherits, so the child's own value
    // wins over the clipPath's. Both sides take the cascade (1gg0.23).
    if ((styleGetter(c.attrs, e.css.get(c))('clip-rule')
         ?? styleGetter(node.attrs, e.css.get(node))('clip-rule')) === 'evenodd')
      evenOdd = true;
    any = true;
  }
  if (!any) return false;
  e.out.push(evenOdd ? 'W* n' : 'W n');
  return true;
}

/** Nesting cap for <image> SVG payloads. */
const MAX_SVG_NESTING = 4;

/** The user-unit box a nested payload's content is expressed in: its viewBox,
 *  else its own width/height. Null when it declares neither, in which case the
 *  <image> rect supplies an identity mapping. Mirrors svgembed.ts's
 *  resolveViewBox, which cannot be imported — that module depends on this one. */
function nestedViewBox(attrs: Map<string, string>): ViewBox | null {
  const vb = parseViewBox(attrs.get('viewBox'));
  if (vb) return vb;
  const w = parseFloat(attrs.get('width') ?? '');
  const h = parseFloat(attrs.get('height') ?? '');
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
    return { minX: 0, minY: 0, w, h };
  return null;
}

/** The viewport an <image> establishes for a nested payload. `x`/`y` default to
 *  0; an absent `width`/`height` takes the payload's own size, and one absent
 *  dimension derives from the other through the payload's aspect ratio — the
 *  same rule imagePlacement applies to a raster. Null when the rect has no area
 *  (SVG 1.1 §5.6 makes that a deliberate no-render, not a reported loss) or when
 *  neither the element nor the payload declares a size, which cannot be placed. */
function nestedRect(
  attrs: Map<string, string>, iw: number, ih: number,
): [number, number, number, number] | null {
  const ax = parseFloat(attrs.get('x') ?? '');
  const ay = parseFloat(attrs.get('y') ?? '');
  const x = Number.isFinite(ax) ? ax : 0;
  const y = Number.isFinite(ay) ? ay : 0;
  let w = parseFloat(attrs.get('width') ?? '');
  let h = parseFloat(attrs.get('height') ?? '');
  const hasIntrinsic = iw > 0 && ih > 0;
  if (!Number.isFinite(w) && !Number.isFinite(h)) {
    if (!hasIntrinsic) return null;
    w = iw; h = ih;
  } else if (!Number.isFinite(w)) w = hasIntrinsic ? (h * iw) / ih : h;
  else if (!Number.isFinite(h)) h = hasIntrinsic ? (w * ih) / iw : w;
  if (!(w > 0) || !(h > 0)) return null;
  return [x, y, w, h];
}

/** Build (or reuse) the Form XObject for a nested payload. Its content is in the
 *  payload's OWN box units and its /BBox is that box, so one form serves every
 *  placement — the caller composes the fit. Null when the payload draws nothing. */
function nestedForm(
  e: Emitter, href: string, root: XmlNode, box: ViewBox,
): PdfObject | null {
  const key = `${href}|${box.minX},${box.minY},${box.w},${box.h}`;
  const hit = e.svgForms.get(key);
  if (hit !== undefined) return hit;

  const g = e.subdoc(box);
  indexIds(root, g.ids);
  if (applyStylesheet(g, root)) g.skipped.add('style');
  walk(g, root, INITIAL, false, [...IDENTITY]);
  if (g.out.length === 0) return null;

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box.minX, box.minY, box.minX + box.w, box.minY + box.h]],
    ['Matrix', [...IDENTITY]],
    ['Resources', buildResources(g)],
  ]);
  const ref = e.streams.stream(dict, g.out.join('\n'));
  e.svgForms.set(key, ref);
  return ref;
}

/** Place a nested SVG payload. The <image> rect is a new viewport, and the
 *  payload's own viewBox + preserveAspectRatio map its content into it. */
function drawNestedSvg(
  e: Emitter, n: XmlNode, href: string, bytes: Uint8Array,
  ctm: Matrix, groupOpacity: number,
): void {
  if (e.svgDepth >= MAX_SVG_NESTING) { e.skipped.add('image'); return; }
  let root: XmlNode;
  try {
    root = parseXml(bytes);
  } catch {
    // parseXml throws PdfParseError on malformed XML. One bad payload must not
    // abort a whole placement — the same rule tryBuild's broad catch encodes for
    // corrupt raster bytes.
    e.skipped.add('image');
    return;
  }
  if (root.name !== 'svg') { e.skipped.add('image'); return; }
  const vb = nestedViewBox(root.attrs);
  const rect = nestedRect(n.attrs, vb?.w ?? 0, vb?.h ?? 0);
  if (rect === null) return;
  const [x, y, w, h] = rect;
  // A payload declaring no box of its own maps 1:1 into the rect.
  const box = vb ?? { minX: 0, minY: 0, w, h };
  const ref = nestedForm(e, href, root, box);
  if (ref === null) { e.skipped.add('image'); return; }

  const f = viewBoxFitDown(box, w, h, root.attrs.get('preserveAspectRatio'));
  const m: Matrix = [f[0], f[1], f[2], f[3], f[4] + x, f[5] + y];
  e.out.push('q');
  // A new viewport clips. /BBox alone is not enough: under `slice` the content
  // is scaled past the rect while still lying inside the payload's viewBox.
  e.out.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`);
  e.out.push('W n');
  if (groupOpacity < 1) e.out.push(`/${e.gsKey(groupOpacity, 1)} gs`);
  e.out.push(`${m.map(num).join(' ')} cm`);
  e.out.push(`/${e.xobjKey(ref, 'Fm')} Do`);
  e.out.push('Q');
  e.addInk({ x, y, w, h }, ctm);
  if (e.ctms) e.ctms.push(ctm);
}

/** Emit one <image>. Reports `image` only when ink that should exist does not:
 *  an href we cannot embed. A zero-area rect draws nothing and is NOT reported —
 *  SVG 1.1 §5.6 makes that the author's choice. */
function drawImage(
  e: Emitter, n: XmlNode, p: Paint, ctm: Matrix, groupOpacity: number,
): void {
  const href = (n.attrs.get('href') ?? n.attrs.get('xlink:href') ?? '').trim();
  if (href === '') { e.skipped.add('image'); return; }
  let hit = e.images.get(href);
  if (hit === undefined) {
    const payload = decodePayload(href, e.resolveImage);
    if (payload === undefined) { e.skipped.add('image'); return; }
    // A vector payload never enters `images`, which holds raster refs plus their
    // pixel size. It is re-decoded per element; `svgForms` is what stops the
    // form being allocated twice.
    if (payload.kind === 'svg') {
      drawNestedSvg(e, n, href, payload.bytes, ctm, groupOpacity);
      return;
    }
    const { w, h } = imageSize(payload.built);
    hit = { ref: e.imageSink.image(payload.built), w, h };
    e.images.set(href, hit);
  }
  const pl = imagePlacement(n.attrs, hit.w, hit.h);
  if (pl === null) return;
  const key = e.xobjKey(hit.ref);
  e.out.push('q');
  if (pl.clip) {
    const [cx, cy, cw, ch] = pl.clip;
    e.out.push(`${num(cx)} ${num(cy)} ${num(cw)} ${num(ch)} re`);
    e.out.push('W n');
  }
  // Group `opacity` ONLY. SVG 1.1 §11.3 does not apply fill-opacity to an
  // image, and an image is a single Do, so the fold into `ca` is exact and no
  // transparency group is needed. These two used to be one number, which is why
  // fill-opacity used to darken an image it should never have touched.
  if (groupOpacity < 1) e.out.push(`/${e.gsKey(groupOpacity, 1)} gs`);
  e.out.push(`${pl.cm.map(num).join(' ')} cm`);
  e.out.push(`/${key} Do`);
  e.out.push('Q');
  e.addInk(pl.box, ctm);
  if (e.ctms) e.ctms.push(ctm);
}

/** The largest raster a single filter may allocate, in pixels. filterScale is
 *  capped at 8, but the filter REGION is author-controlled and unbounded, so
 *  the cap has to be on the product. At 4 bytes per channel per Surface and
 *  several live surfaces, 16 Mpx is already a few hundred MB of Float32. */
const MAX_FILTER_PX = 16_000_000;

/** Rasterize one feImage reference into a Surface over the region raster.
 *
 *  Both reference kinds go through the SAME sink the filtered subtree uses: an
 *  element reference by walking that subtree into a form, a data: URI by
 *  building a one-operator form that draws the decoded Image XObject. Returns
 *  null when the reference cannot be resolved, which makes the whole filter
 *  refuse — SVG has no partial-filter semantics, and a silently empty feImage
 *  is indistinguishable from one the author meant to be empty. */
function rasterizeFeImage(
  e: Emitter, p: FilterPrim, region: SegBBox, px: number, W: number, H: number,
): Surface | null {
  if (!e.raster) return null;
  const href = (p.attrs.get('href') ?? p.attrs.get('xlink:href') ?? '').trim();
  const sub = p.sub;
  if (!(sub.w > 0) || !(sub.h > 0)) return null;
  const devW = Math.max(1, Math.round(sub.w * px));
  const devH = Math.max(1, Math.round(sub.h * px));

  const g = e.child();
  if (href.startsWith('#')) {
    const id = href.slice(1);
    const target = id === '' ? undefined : e.ids.get(id);
    // Missing, or a cycle. This is the ONLY unbounded recursion a filter can
    // reach -- the one place a filter re-enters arbitrary document content
    // rather than descending its own target's subtree -- so it is the only
    // place a filter needs a cycle guard. `active` is shared with every child
    // and grows monotonically down the recursion, so a self-reference, a
    // mutual pair, and any longer ring all terminate here (1gg0.10.7).
    if (!target || e.active.has(id)) return null;
    e.active.add(id);
    // The referenced element renders in the filter's own user space — the same
    // space `walk` is already emitting in.
    walk(g, target, INITIAL, false, [...IDENTITY]);
    e.active.delete(id);
  } else {
    const built = decodeImage(href, e.resolveImage);
    if (built === undefined) return null;
    const { w: iw, h: ih } = imageSize(built);
    if (!(iw > 0) || !(ih > 0)) return null;
    const ref = e.imageSink.image(built);
    const key = g.xobjKey(ref);
    // feImage honours preserveAspectRatio over its subregion, like <image>.
    const f = fitBox({ w: iw, h: ih }, { w: sub.w, h: sub.h },
                     p.attrs.get('preserveAspectRatio'));
    const bw = iw * f.sx, bh = ih * f.sy;
    const bx = sub.x + f.tx, by = sub.y + f.ty;
    // The local -bh cancels placementMatrix's flip; see imagePlacement.
    g.out.push('q');
    g.out.push(`${num(bw)} 0 0 ${num(-bh)} ${num(bx)} ${num(by + bh)} cm`);
    g.out.push(`/${key} Do`);
    g.out.push('Q');
  }
  if (g.out.length === 0) return null;

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [sub.x, sub.y, sub.x + sub.w, sub.y + sub.h]],
    ['Matrix', [...IDENTITY]],
    ['Group', new Map<string, PdfObject>([
      ['Type', name('Group')], ['S', name('Transparency')],
    ])],
    ['Resources', buildResources(g)],
  ]);
  const img = e.raster.rasterize(dict, g.out.join('\n'), devW, devH);
  if (img === null) return null;

  // Place the subregion raster into a full-region surface at its own offset:
  // runFilter addresses every result in region-raster coordinates.
  const patch = toSurface(flipRows(img));
  const out = makeSurface(0, 0, W, H);
  const ox = Math.round((sub.x - region.x) * px);
  const oy = Math.round((sub.y - region.y) * px);
  for (let y = 0; y < patch.h; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= H) continue;
    for (let x = 0; x < patch.w; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= W) continue;
      for (let c = 0; c < 4; c++)
        out.data[(dy * W + dx) * 4 + c] = patch.data[(y * patch.w + x) * 4 + c];
    }
  }
  return out;
}

/** Rasterize `body`'s subtree over the filter region, run the graph, and emit
 *  the result as an image. Returns false when it could not be done, in which
 *  case the caller paints the element unfiltered.
 *
 *  The image is drawn where `paintInto` would have painted — inside the
 *  element's own `cm` and inside any clip/mask wrapper — which is exactly SVG's
 *  order: filter, then clip-path, then mask, then opacity. */
function emitFiltered(
  e: Emitter, spec: FilterSpec, scale: number, body: (sub: Emitter) => void,
): boolean {
  if (!e.raster) return false;
  const region = spec.region;

  let devW = Math.max(1, Math.round(region.w * scale));
  let devH = Math.max(1, Math.round(region.h * scale));
  if (spec.res) { devW = Math.min(devW, spec.res[0]); devH = Math.min(devH, spec.res[1]); }
  if (devW * devH > MAX_FILTER_PX) {
    const k = Math.sqrt(MAX_FILTER_PX / (devW * devH));
    devW = Math.max(1, Math.floor(devW * k));
    devH = Math.max(1, Math.floor(devH * k));
  }
  // The scale the KERNELS see: what the raster actually came out at, not what
  // was asked for. A capped raster whose kernels still used the requested scale
  // would blur and offset by the wrong number of pixels.
  const px = devW / region.w;

  const g = e.child();
  body(g);
  if (g.out.length === 0) return false;
  const formDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [region.x, region.y, region.x + region.w, region.y + region.h]],
    ['Matrix', [...IDENTITY]],
    ['Group', new Map<string, PdfObject>([
      ['Type', name('Group')], ['S', name('Transparency')],
    ])],
    ['Resources', buildResources(g)],
  ]);
  const img = e.raster.rasterize(formDict, g.out.join('\n'), devW, devH);
  if (img === null) return false;

  // Pre-rasterize every feImage reference. A failure refuses the WHOLE filter:
  // SVG has no partial-filter semantics, and an feImage that silently rendered
  // nothing would be indistinguishable from one the author meant to be empty.
  let extras: Map<string, Surface> | undefined;
  for (const fp of spec.prims) {
    if (fp.name !== 'feImage') continue;
    const s = rasterizeFeImage(e, fp, region, px, img.w, img.h);
    if (s === null) return false;
    (extras ??= new Map()).set(fp.result, s);
  }

  // flipRows is the y-down/y-up bridge: the rasterizer read our y-down content
  // as ordinary y-up PDF, so its rows arrive bottom-first. Filters run y-down,
  // and surfaceImage's result is placed top-down by the `cm` below.
  const out = runFilter(spec, toSurface(flipRows(img)), px, extras);
  const ref = e.imageSink.image(surfaceImage(out));
  const key = e.xobjKey(ref);
  // A PDF image fills the unit square with its first row at v = 1, and this
  // space is y-DOWN, so the local -h is the flip that cancels the one in
  // placementMatrix. Mirrors svgimage.ts's imagePlacement.
  e.out.push('q');
  e.out.push(
    `${num(region.w)} 0 0 ${num(-region.h)} ${num(region.x)} ${num(region.y + region.h)} cm`);
  e.out.push(`/${key} Do`);
  e.out.push('Q');
  return true;
}

/** A subregion as a clip. y-down, like everything else this module emits. */
const rectClip = (b: SegBBox): string =>
  `${num(b.x)} ${num(b.y)} ${num(b.w)} ${num(b.h)} re W n`;

/** Emit a chain PDF can express exactly, instead of rasterizing it (1gg0.10.5).
 *
 *  Paints where `emitFiltered` would have, inside the element's own transform
 *  and inside any clip/mask wrapper, so SVG's filter -> clip-path -> mask ->
 *  opacity order is unchanged.
 *
 *  Returns void, not boolean: unlike emitFiltered this cannot fail. classify
 *  only hands back chains this can draw, and none of them touch the rasterizer
 *  -- which is why these filters now render even where no raster sink is wired. */
function emitFastFilter(
  e: Emitter, fast: FastPath, region: SegBBox, body: (sub: Emitter) => void,
): void {
  switch (fast.kind) {
    case 'offset': {
      // The form's /BBox is the region clip, and a /BBox applies in the form's
      // OWN space -- so SourceGraphic is cut to the region BEFORE the cm shifts
      // it, which is SVG's order (15.7.5). Translating the region rectangle
      // instead would let a large offset drag back in ink the region had
      // already removed.
      const form = groupForm(e, region, body);
      e.out.push('q');
      e.out.push(rectClip(fast.clip));
      if (fast.dx !== 0 || fast.dy !== 0)
        e.out.push(`1 0 0 1 ${num(fast.dx)} ${num(fast.dy)} cm`);
      e.out.push(`/${e.xobjKey(form, 'Fm')} Do`);
      e.out.push('Q');
      return;
    }
    case 'flood': {
      e.out.push('q');
      if (fast.opacity < 1) e.out.push(`/${e.gsKey(fast.opacity, 1)} gs`);
      e.out.push(`${fast.color.map(num).join(' ')} rg`);
      // The fill rectangle IS the clip. A flood paints its whole subregion and
      // nothing outside it, so a `re W n` would be the same rectangle twice.
      e.out.push(
        `${num(fast.clip.x)} ${num(fast.clip.y)} ${num(fast.clip.w)} ${num(fast.clip.h)} re`);
      e.out.push('f');
      e.out.push('Q');
      return;
    }
    case 'tint': {
      // /S /Alpha, not /Luminosity: feComposite operator="in" reads in2's ALPHA
      // and nothing else. An alpha soft mask needs no /CS, so the group
      // groupForm already builds is the right one unchanged.
      const form = groupForm(e, region, body);
      e.out.push('q');
      e.out.push(`/${e.gsKey(fast.opacity, 1, form, 'Alpha')} gs`);
      e.out.push(`${fast.color.map(num).join(' ')} rg`);
      e.out.push(
        `${num(fast.clip.x)} ${num(fast.clip.y)} ${num(fast.clip.w)} ${num(fast.clip.h)} re`);
      e.out.push('f');
      e.out.push('Q');
      return;
    }
  }
}

/** The path data a textPath asks for: inline first, else a same-document
 *  `<path>`. null when there is nothing usable to lay text on. */
function textPathSegs(e: Emitter, spec: TextPathSpec): SvgSeg[] | null {
  let d: string | undefined;
  if (spec.inline !== null) {
    d = spec.inline;
  } else if (spec.href !== null) {
    const node = e.ids.get(spec.href);
    // Only a <path>. SVG 2 allows a shape here, which this stack does not do —
    // the element's own `transform` is ignored either way, since SVG 1.1
    // §10.13.3 puts the data in the textPath's user space, not the path's.
    if (node && node.name === 'path') d = node.attrs.get('d');
  }
  if (d === undefined) return null;
  const { segs } = parsePath(d);
  return segs.length === 0 ? null : segs;
}

/** startOffset as a distance: a percentage of the path length, or a length. */
function startOffsetOf(raw: string, total: number): number {
  const s = raw.trim();
  const pct = s.endsWith('%');
  const n = parseFloat(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return 0;
  return pct ? (n / 100) * total : n;
}

/** Map each textPath owner's glyphs onto its own geometry.
 *
 *  Returns the surviving glyphs. An owner whose reference cannot be resolved is
 *  reported and left alone, so its text stays on the baseline — visible ink
 *  beats silently dropped content, the same way an unresolvable filter degrades
 *  to unfiltered. A path that resolves but has no extent renders nothing and is
 *  NOT reported: SVG mandates that outcome. */
function applyTextPaths(
  e: Emitter, flat: FlatText, glyphs: PlacedGlyph[], ctm: Matrix,
): { glyphs: PlacedGlyph[]; stretched: StretchedRun[] } {
  let out = glyphs;
  const stretched: StretchedRun[] = [];
  for (let o = 0; o < flat.owners.length; o++) {
    const spec = flat.owners[o].path;
    if (spec === undefined) continue;
    const segs = textPathSegs(e, spec);
    if (segs === null) { e.skipped.add('textPath'); continue; }
    let m = measurePath(segs);
    if (spec.side === 'right') m = reverseMetrics(m);
    const off = startOffsetOf(spec.startOffset, m.total);
    const mine = (g: PlacedGlyph): boolean => g.chain.includes(o);

    if (spec.stretch) {
      if (canStretch(out, mine)) {
        // BEFORE mapGlyphsToPath, which mutates g.x/g.y in place: the warp
        // reads the chunk-local layout, where x is distance along the run.
        // Flatness is device-relative, so an SVG placed into a large rect gets
        // finer subdivision rather than visible faceting.
        for (const r of stretchGlyphs(out, mine, m, off, FLATTEN_TOL / ctmScale(ctm)))
          stretched.push(r);
        // The glyphs still go through the mapping below: they become the
        // invisible layer that keeps the run extractable.
        for (const g of out) if (mine(g)) g.invisible = true;
      } else {
        e.skipped.add('textPath');       // no outlines: renders as align
      }
    }
    out = mapGlyphsToPath(out, mine, m, off);
  }
  return { glyphs: out, stretched };
}

/** Walk one element. `inDefs` suppresses painting, so defs/symbol contents are
 *  indexed for later `use` but never drawn where they sit. */
function walk(e: Emitter, n: XmlNode, parent: Paint, inDefs: boolean, ctm: Matrix): void {
  if (NON_RENDERING.has(n.name)) return;

  if (!STRUCTURAL.has(n.name) && !SHAPES.has(n.name)) {
    e.skipped.add(n.name);
    return;
  }

  const { paint, refs, groupOpacity } = resolveStyle(parent, n.attrs, e.css.get(n));
  for (const id of refs) {
    const target = e.ids.get(id);
    // A paint-server reference is handled in paintShape, which reports its own
    // fidelity losses. Anything else is still unsupported.
    if (target && (target.name === 'linearGradient' || target.name === 'radialGradient'
                   || target.name === 'pattern'))
      continue;
    e.skipped.add(target ? target.name : 'url()');
  }

  // A clip-path opens its own q/Q so the clip is popped with the element.
  // Through styleGetter, like `mask` and `filter` below: clip-path is a CSS
  // property, so a stylesheet or an inline style has to be able to both set it
  // AND switch it off with `none`, which urlRef rejects for us.
  const clipId = urlRef(styleGetter(n.attrs, e.css.get(n))('clip-path'));
  const clipNode = clipId !== undefined ? e.ids.get(clipId) : undefined;
  let clipped = false;
  if (clipNode && clipNode.name === 'clipPath' && !inDefs) {
    e.out.push('q');
    clipped = emitClip(e, clipNode);
    if (!clipped) e.out.pop();      // nothing emitted: drop the stray q
  }

  const tf = parseTransform(n.attrs.get('transform'));
  const hasTf = tf.some((v, i) => v !== IDENTITY[i]);
  // The walker's own accumulated matrix, mirroring the `cm` it emits. PDF holds
  // the same value in its graphics state; a pattern /Matrix cannot read that
  // back, so it is tracked here too.
  const here = hasTf ? mul(tf, ctm) : ctm;
  if (hasTf) { e.out.push('q'); e.out.push(`${tf.map(num).join(' ')} cm`); }

  // Decided here, before anything reads `paint`: an element that gets a
  // transparency group must NOT also fold the alpha into its own paints, and
  // one that does not must. This sits after the transform rather than beside
  // resolveStyle because viewportBox needs `here`.
  const opacityBox =
    groupOpacity < 1 && !inDefs && !DEFINITION.has(n.name) && needsOpacityGroup(n, paint)
      ? viewportBox(e, here)
      : null;
  if (opacityBox === null && groupOpacity < 1) {
    paint.fillOpacity *= groupOpacity;
    paint.strokeOpacity *= groupOpacity;
  }

  // The element's own painting, factored out so a mask can route it into a
  // transparency group instead of straight into this stream.
  const paintInto = (t: Emitter): void => {
    if (DEFINITION.has(n.name)) {
      // Only ever reached through a reference (clip-path, a url() paint, or
      // mask=), never painted in its own right.
    } else if (n.name === 'use') {
      const id = (n.attrs.get('href') ?? '').replace(/^#/, '');
      const target = id === '' ? undefined : t.ids.get(id);
      if (!target || t.active.has(id)) {
        t.skipped.add('use');          // missing target, or a reference cycle
      } else if (!inDefs) {
        const dx = attrNum(n, 'x'), dy = attrNum(n, 'y');
        const shift = dx !== 0 || dy !== 0;
        if (shift) { t.out.push('q'); t.out.push(`1 0 0 1 ${num(dx)} ${num(dy)} cm`); }
        t.active.add(id);
        walk(t, target, paint, false, shift ? mul([1, 0, 0, 1, dx, dy], here) : here);
        t.active.delete(id);
        if (shift) t.out.push('Q');
      }
    } else if (n.name === 'text') {
      if (!inDefs) {
        // SVG's initial font-size is 16; the walker carries no inherited value,
        // since only a <text> subtree has one.
        // `parent`, NOT `paint`: flattenText resolves the <text> node's own
        // attributes itself, so handing it the paint `walk` already resolved
        // applied every own-element property twice — fill-opacity="0.5" came
        // out at 0.25 and opacity="0.5" fill-opacity="0.5" at 0.0625.
        const flat = flattenText(n, parent, t.fonts, 16, t.css, opacityBox !== null);
        for (const s of flat.skipped) t.skipped.add(s);
        let glyphs = layoutText(flat);
        const mapped = applyTextPaths(t, flat, glyphs, here);
        glyphs = mapped.glyphs;
        // Warped outlines are ordinary path geometry, so paintShape gives them
        // gradients, patterns, stroke and the objectBoundingBox box for free.
        // fill-rule is forced to nonzero: SVG's fill-rule governs the author's
        // geometry, while glyph contours are font geometry defined under
        // nonzero winding, and evenodd would punch holes through the
        // overlapping contours some faces use.
        for (const r of mapped.stretched)
          paintShape(t, r.segs, { ...r.style.paint, fillRule: 'nonzero' }, here);
        const dec = decorationOps(glyphs);
        for (const op of dec.beneath) t.out.push(op);
        const drew = emitGlyphs(glyphs, t, here);
        // Only faces that actually reached the stream: flattenText asks the
        // provider for a seed face before reading font-family, so registering
        // everything the provider knows would carry an unreferenced font.
        if (drew) {
          for (const g of glyphs) t.usedFonts.add(g.style.face.key);
          t.addInk(glyphsBBox(glyphs), here);
        }
        for (const op of dec.above) t.out.push(op);
        // Nothing drawn from characters that existed means the face could encode
        // none of them: ink that should exist does not, so it is reported.
        if (!drew && flat.chars.length > 0) t.skipped.add('text');
        if (t.ctms && drew) t.ctms.push(here);
      }
    } else if (n.name === 'image') {
      // Only from the painting branch: a <defs> image must allocate no XObject
      // that nothing references.
      if (!inDefs) drawImage(t, n, paint, here, groupOpacity);
    } else if (SHAPES.has(n.name)) {
      if (!inDefs) {
        const { segs, truncated } = shapeSegs(n);
        if (truncated) t.skipped.add(n.name);
        // `fill` does not apply to <line> (SVG 1.1 §11.3): it encloses no area.
        // Without this a bare <line> would emit a fill operator for the inherited
        // black, painting nothing but making every line read as fill-and-stroke.
        paintShape(t, segs,
          n.name === 'line' ? { ...paint, fill: null, fillRef: null } : paint, here);
        // Markers apply to path, line, polyline and polygon only (SVG 1.1
        // §11.6.2) — never to rect, circle or ellipse, which have no vertices
        // an author can reason about.
        if (n.name === 'path' || n.name === 'line'
            || n.name === 'polyline' || n.name === 'polygon')
          paintMarkers(t, segs, paint, here);
      }
    } else {
      const childrenInDefs = inDefs || n.name === 'defs' || n.name === 'symbol';
      for (const c of n.children) walk(t, c, paint, childrenInDefs, here);
    }
  };

  // SVG's order is filter -> clip-path -> mask -> opacity. The filter replaces
  // the subtree with an image, so it is INNERMOST here: `clipped` above and the
  // mask wrapper below already surround whatever paintInto emits.
  let painted = paintInto;
  const filterAttr = styleGetter(n.attrs, e.css.get(n))('filter');
  if (filterAttr !== undefined && filterAttr.trim() !== 'none'
      && !inDefs && !DEFINITION.has(n.name)) {
    const fid = urlRef(filterAttr);
    const fnode = fid !== undefined ? e.ids.get(fid) : undefined;
    if (!fnode || fnode.name !== 'filter') {
      // A missing target, or a CSS filter function like blur(2px), which this
      // stack does not parse. Either way the element draws unfiltered.
      e.skipped.add('url()');
    } else {
      // No same-filter guard here, deliberately (1gg0.10.7). Unlike a mask, a
      // pattern or a marker -- whose DEFINITION content is re-entered and can
      // point back at itself -- a filter re-enters the TARGET ELEMENT's
      // subtree, which is strictly smaller each time, so nesting terminates on
      // its own. An ancestor and a descendant carrying the same filter= is
      // legal SVG and each applies it independently. The one unbounded path is
      // feImage's element reference, and `active` already breaks that; see
      // rasterizeFeImage.
      // objectBoundingBox is the DEFAULT for filterUnits, so this is the common
      // path. An incomplete box cannot place the region, and a region that
      // cannot be placed would crop the element, so it degrades to unfiltered.
      const { box, complete } = subtreeBBox(n, e.ids, textMeasure(e));
      const r = complete
        // `paint` is the element's own resolved paint, which is what
        // FillPaint/StrokePaint are planes of. For a <g> that is the group's
        // fill, which is also what its children inherit -- the same value SVG
        // means by "the fill property on the target element".
        ? resolveFilter(fnode, box, e.viewport, e.css.get(fnode), paint,
                        e.resolveImage !== undefined)
        : { kind: 'skip' as const, report: ['filter'] };
      if (r.kind === 'empty') {
        // SVG 1.1 §15.7.2: a zero-area filter region renders the element as
        // nothing. The author asked for it, so nothing is reported.
        painted = () => {};
      } else if (r.kind === 'skip') {
        for (const s of r.report) e.skipped.add(s);
      } else {
        const inner = paintInto;
        const fast = classify(r.spec);
        if (fast !== null) {
          const region = r.spec.region;
          painted = (t: Emitter): void => { emitFastFilter(t, fast, region, inner); };
        } else {
          const scale = e.filterPx * ctmScale(here);
          painted = (t: Emitter): void => {
            const ok = emitFiltered(t, r.spec, scale, inner);
            if (ok) t.rasterized.add('filter');
            else { t.skipped.add('filter'); inner(t); }
          };
        }
      }
    }
  }

  const maskId = urlRef(styleGetter(n.attrs, e.css.get(n))('mask'));
  const maskNode = maskId !== undefined ? e.ids.get(maskId) : undefined;
  let group: PdfObject | null = null;
  let spec: MaskSpec | null = null;
  if (maskId !== undefined && !inDefs && !DEFINITION.has(n.name)) {
    if (!maskNode || maskNode.name !== 'mask') {
      e.skipped.add('url()');
    } else {
      // objectBoundingBox is the DEFAULT, so this is the common path, not an
      // edge case. A box that cannot cover the ink would silently crop the
      // element, so an incomplete one degrades to unmasked instead.
      const { box, complete } = subtreeBBox(n, e.ids, textMeasure(e));
      spec = complete
        ? resolveMask(maskNode, box, e.viewport, e.css.get(maskNode))
        : null;
      group = spec ? maskFor(e, maskNode, spec) : null;
      if (!group) e.skipped.add('mask');
    }
  }

  // The mask wrapper, factored into a callable so the opacity group can contain
  // it. SVG's order is filter -> clip-path -> mask -> opacity, so opacity is
  // outermost of the four and the mask must sit inside it.
  //
  // Copied into consts first: `group` and `spec` are `let`, and TypeScript does
  // not carry a narrowing on a mutable binding into a closure.
  const mg = group, ms = spec;
  const masked: (t: Emitter) => void = (mg !== null && ms !== null)
    ? (t: Emitter): void => {
        const body = groupForm(t, ms.region, painted);
        t.out.push('q');
        t.out.push(`/${t.gsKey(1, 1, mg, ms.type)} gs`);
        t.out.push(`/${t.xobjKey(body, 'Fm')} Do`);
        t.out.push('Q');
      }
    : painted;

  if (opacityBox !== null) {
    // Inside the element's own `transform` q/Q rather than outside it, which is
    // equivalent — fading a whole group commutes with an enclosing affine and
    // with an enclosing clip — and it keeps groupForm's contract that /Matrix is
    // identity and the box is in the element's own user space.
    const form = groupForm(e, opacityBox, masked);
    e.out.push('q');
    e.out.push(`/${e.gsKey(groupOpacity, groupOpacity)} gs`);
    e.out.push(`/${e.xobjKey(form, 'Fm')} Do`);
    e.out.push('Q');
  } else {
    masked(e);
  }

  if (hasTf) e.out.push('Q');
  if (clipped) e.out.push('Q');
}

/** Collect and compile the document's stylesheet, and resolve it against every
 *  element. Returns whether anything had to be dropped.
 *
 *  A pre-pass rather than per-element work in `walk`, because a <style> may
 *  appear AFTER what it styles. */
function applyStylesheet(e: Emitter, root: XmlNode): boolean {
  const { css, badType } = collectStyleText(root);
  if (css.trim() === '') return badType;
  const sheet = parseStylesheet(css);
  e.css = resolveAll(root, sheet);
  return sheet.dropped || badType;
}

/** The /Resources for one content stream. Called once for the form and once per
 *  pattern tile: a tile's stream cannot see the form's dictionary, so each
 *  carries its own, holding only what that stream actually referenced. */
function buildResources(e: Emitter): PdfDict {
  const res: PdfDict = new Map<string, PdfObject>();
  if (e.extg.size > 0) res.set('ExtGState', e.extg);
  if (e.pat.size > 0) res.set('Pattern', e.pat);
  if (e.xobj.size > 0) res.set('XObject', e.xobj);
  if (e.usedFonts.size > 0) {
    const all = e.fonts.dict();
    const fonts: PdfDict = new Map<string, PdfObject>();
    for (const k of e.usedFonts) {
      const v = all.get(k);
      if (v !== undefined) fonts.set(k, v);
    }
    if (fonts.size > 0) res.set('Font', fonts);
  }
  return res;
}

/** Render an `<svg>` tree to a content stream. The root's own viewBox is NOT
 *  applied here — svgembed.ts folds it into the placement matrix. */
export function drawSvg(
  root: XmlNode, viewport: ViewBox, provider: SvgFontProvider,
  streams: SvgStreamSink, images: SvgImageSink, opts: SvgDrawOptions = {},
): DrawResult {
  const e = new Emitter();
  e.viewport = viewport;
  e.fonts = provider;
  e.streams = streams;
  e.imageSink = images;
  e.raster = opts.raster;
  e.resolveImage = opts.resolveImage;
  e.filterPx = (opts.deviceScale ?? 1) * (opts.filterScale ?? 2);
  indexIds(root, e.ids);
  if (applyStylesheet(e, root)) e.skipped.add('style');
  walk(e, root, INITIAL, false, [...IDENTITY]);
  return {
    content: e.out.join('\n'),
    resources: buildResources(e),
    skipped: [...e.skipped].sort(),
    rasterized: [...e.rasterized].sort(),
  };
}

/** Test-only: the CTM in effect at each painted shape, in paint order. The
 *  pattern /Matrix covers the group case through the public output; this covers
 *  the <use> shift and the pop-out on a sibling, which it does not. */
export function __ctmProbe(
  root: XmlNode, viewport: ViewBox, provider: SvgFontProvider,
  streams: SvgStreamSink, images: SvgImageSink,
): Matrix[] {
  const e = new Emitter();
  e.viewport = viewport;
  e.fonts = provider;
  e.streams = streams;
  e.imageSink = images;
  e.ctms = [];
  indexIds(root, e.ids);
  applyStylesheet(e, root);        // the probe reports nothing, but must style
  walk(e, root, INITIAL, false, [...IDENTITY]);
  return e.ctms;
}
