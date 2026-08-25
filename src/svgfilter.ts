// SVG <filter> -> a primitive graph (issue 1gg0.10.3). Pure: region, subregion
// and input resolution, with no pixels involved. Mirrors svgmask.ts's role --
// it decides geometry and hands back a descriptor, allocating nothing. The
// kernels that consume this live in svgfilterfx.ts.
import type { XmlNode } from './xml.js';
import type { SegBBox } from './svgpath.js';
import { unitLength, type ViewBox } from './svgtransform.js';
import { parseColor, styleGetter, type Paint, type Rgb } from './svgstyle.js';
import type { CssDecls } from './svgcss.js';

/** One filter primitive, with its inputs resolved to keys. */
export interface FilterPrim {
  /** Element name, e.g. 'feGaussianBlur'. */
  name: string;
  /** Resolved key of the first input: 'SourceGraphic', 'SourceAlpha', or a
   *  result name. */
  in1: string;
  /** Resolved key of the second input; '' for a one-input primitive. */
  in2: string;
  /** The key this primitive's output is stored under. */
  result: string;
  /** Subregion, in the element's user space (y-down). */
  sub: SegBBox;
  /** The primitive's own attributes. */
  attrs: Map<string, string>;
  /** The element itself, for primitives that read children (feMerge,
   *  feComponentTransfer). */
  node: XmlNode;
  /** color-interpolation-filters for THIS primitive. */
  space: 'linearRGB' | 'sRGB';
}

/** A resolved <filter>: where it applies and what to run inside it. */
export interface FilterSpec {
  /** The filter region, in the element's user space (y-down). */
  region: SegBBox;
  prims: FilterPrim[];
  /** primitiveUnits === 'objectBoundingBox'. */
  obb: boolean;
  /** The element's bbox. Non-null whenever `obb` is true. */
  bbox: SegBBox | null;
  /** filterRes, when given: a hard cap on the raster in device pixels. */
  res?: [number, number];
  /** The element's own paint, for the FillPaint/StrokePaint pseudo-inputs.
   *  `null` in either slot means that paint is `none`: a transparent plane.
   *  Absent when the caller supplied no paint, which refuses both. */
  paint?: { fill: Rgb | null; stroke: Rgb | null };
}

/** A discriminated union rather than a nullable spec: the three outcomes are
 *  genuinely different, and a caller that cannot tell 'renders nothing, as
 *  asked' from 'cannot run this' will report one as the other. */
export type FilterResolution =
  /** Run it. */
  | { kind: 'draw'; spec: FilterSpec }
  /** A zero-area filter region: SVG 1.1 §15.7.2 says the element renders
   *  nothing. The author asked for that, so it is NOT reported. */
  | { kind: 'empty' }
  /** Cannot run it: draw the element unfiltered and add `report` to skipped. */
  | { kind: 'skip'; report: string[] };

/** The primitives this build can actually run.
 *
 *  INVARIANT: this set equals the kernel table in svgfilterfx.ts's runFilter,
 *  and a name is added here in the SAME commit as its kernel. Listing a
 *  primitive early makes it pass its input through untouched -- plausible ink
 *  that is silently wrong, which is worse than a reported refusal. */
const SUPPORTED = new Set([
  'feFlood', 'feOffset', 'feMerge', 'feComposite', 'feBlend', 'feColorMatrix',
  'feComponentTransfer', 'feGaussianBlur', 'feDropShadow', 'feMorphology', 'feTile',
  'feConvolveMatrix', 'feDisplacementMap', 'feImage', 'feTurbulence',
  'feDiffuseLighting', 'feSpecularLighting',
]);

/** Every input key a primitive actually reads.
 *
 *  feMerge is the exception that makes this a function rather than a field
 *  read: it carries no `in` of its own, because its inputs live on its
 *  feMergeNode children. An feMergeNode is NOT a primitive and joins no
 *  implicit chain, so a missing `in` on one means SourceGraphic, never the
 *  previous result.
 *
 *  Both the resolver's validation and runFilter's seeding go through here. They
 *  used to read in1/in2 directly, which let an feMerge name anything at all --
 *  an unsupported pseudo-input, or a plain typo -- and still resolve as
 *  runnable, then silently yield a transparent surface. Found by routing
 *  FillPaint through the idiomatic feMerge spelling (1gg0.10.6). */
export function primInputs(
  p: { name: string; node: XmlNode; in1: string; in2: string },
): string[] {
  if (p.name !== 'feMerge') return p.in2 === '' ? [p.in1] : [p.in1, p.in2];
  return p.node.children.filter((c) => c.name === 'feMergeNode')
    .map((c) => c.attrs.get('in') ?? 'SourceGraphic');
}

/** Whether a pseudo-input can actually be produced for THIS element.
 *
 *  SourceGraphic and SourceAlpha always can. FillPaint and StrokePaint need the
 *  element's resolved paint, which reaches here only when the caller passes it
 *  -- so an absent `paint` refuses both, which is what every caller did before
 *  1gg0.10.6 and what leaves them unchanged. A gradient or pattern paint server
 *  (fillRef/strokeRef) cannot be flattened to one colour and refuses; `none` is
 *  fine, because a transparent plane is exactly what SVG defines it as, and
 *  stroke DEFAULTS to none.
 *
 *  BackgroundImage and BackgroundAlpha still fall through: they need the
 *  accumulated page backdrop, which a single-pass walker does not retain and
 *  which no shipping browser has ever implemented. */
function pseudoOk(v: string, paint: Paint | undefined): boolean {
  if (v === 'SourceGraphic' || v === 'SourceAlpha') return true;
  if (v === 'FillPaint') return paint !== undefined && paint.fillRef === null;
  if (v === 'StrokePaint') return paint !== undefined && paint.strokeRef === null;
  return false;
}

/** Whether an feConvolveMatrix's order/kernelMatrix/target agree. Duplicated
 *  deliberately rather than imported from svgfilterfx.ts, which already imports
 *  THIS module — the alternative is an import cycle for six lines of
 *  arithmetic. */
function validConvolve(attrs: Map<string, string>): boolean {
  const ord = (attrs.get('order') ?? '3').trim().split(/[\s,]+/).map(Number);
  const ox = Math.floor(ord[0]);
  const oy = Math.floor(ord.length > 1 ? ord[1] : ord[0]);
  if (!(ox > 0) || !(oy > 0)) return false;
  const k = (attrs.get('kernelMatrix') ?? '').trim().split(/[\s,]+/)
    .map(Number).filter((n) => Number.isFinite(n));
  if (k.length !== ox * oy) return false;
  const tX = parseFloat(attrs.get('targetX') ?? '');
  const tY = parseFloat(attrs.get('targetY') ?? '');
  if (Number.isFinite(tX) && (tX < 0 || tX >= ox)) return false;
  if (Number.isFinite(tY) && (tY < 0 || tY >= oy)) return false;
  return true;
}

/** An feImage href this stack can resolve: '#id', a data: URI, or — when the
 *  caller supplied a resolveImage — any non-empty href. Only the resolver can
 *  say whether it has the bytes, and it is not consulted until rasterize time,
 *  so validation cannot pre-judge an external href once one exists. A resolver
 *  that then declines fails the rasterize, which reports `filter` rather than
 *  `feImage` — the generic path every rasterize-time failure takes. */
function validImageHref(attrs: Map<string, string>, hasResolver: boolean): boolean {
  const h = (attrs.get('href') ?? attrs.get('xlink:href') ?? '').trim();
  if (h.startsWith('#') || /^data:/i.test(h)) return true;
  return hasResolver && h !== '';
}

/** Anything in the fe* namespace is a primitive; other children (title, desc, a
 *  stray <script>) are ignored rather than reported -- they render nothing
 *  wherever they appear. */
const isPrimitive = (n: XmlNode): boolean => n.name.startsWith('fe');

/** `filterRes`, when it parses to two positive numbers. Deprecated in SVG 1.1
 *  and dropped in SVG 2, but honoured: an author who wrote it wanted a cap. */
function filterRes(v: string | undefined): [number, number] | undefined {
  if (v === undefined) return undefined;
  const p = v.trim().split(/[\s,]+/).map(Number);
  const [w, h] = p.length === 1 ? [p[0], p[0]] : p;
  if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return undefined;
  return [Math.floor(w), Math.floor(h)];
}

/** Intersect a subregion with the filter region. A primitive may not paint
 *  outside the filter region (SVG 1.1 §15.7.5), so this is the real extent. */
function clipTo(a: SegBBox, r: SegBBox): SegBBox {
  const x0 = Math.max(a.x, r.x), y0 = Math.max(a.y, r.y);
  const x1 = Math.min(a.x + a.w, r.x + r.w), y1 = Math.min(a.y + a.h, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** The x/y/width/height subregion of one primitive. Each axis defaults
 *  INDEPENDENTLY to the filter region's, so `x` alone narrows the left edge and
 *  leaves the right one where the region put it. */
function subregion(
  attrs: Map<string, string>, region: SegBBox, obb: boolean, bbox: SegBBox | null,
): SegBBox {
  const sx = obb && bbox ? bbox.w : 1;
  const sy = obb && bbox ? bbox.h : 1;
  const ox = obb && bbox ? bbox.x : 0;
  const oy = obb && bbox ? bbox.y : 0;
  const has = (k: string): boolean => attrs.get(k) !== undefined;
  const at = (k: string, s: number, o: number): number => {
    const n = parseFloat(attrs.get(k) ?? '');
    return Number.isFinite(n) ? n * s + o : 0;
  };
  const x = has('x') ? at('x', sx, ox) : region.x;
  const y = has('y') ? at('y', sy, oy) : region.y;
  const w = has('width') ? at('width', sx, 0) : region.x + region.w - x;
  const h = has('height') ? at('height', sy, 0) : region.y + region.h - y;
  return clipTo({ x, y, w: Math.max(0, w), h: Math.max(0, h) }, region);
}

/** A length-valued primitive parameter -- stdDeviation, dx, radius -- under the
 *  filter's primitiveUnits. `axis` picks the bbox side an objectBoundingBox
 *  fraction scales by; the two differ on a non-square box. */
export function primLength(
  spec: FilterSpec, v: string | undefined, dflt: number, axis: 'x' | 'y',
): number {
  const n = parseFloat(v ?? '');
  if (!Number.isFinite(n)) return dflt;
  if (!spec.obb || !spec.bbox) return n;
  return n * (axis === 'x' ? spec.bbox.w : spec.bbox.h);
}

/** A chain PDF can express EXACTLY, so it never reaches the rasterizer.
 *
 *  Deliberately narrow. Each member is a second implementation of a primitive
 *  the raster path already runs, and every one has to be provably equal to it --
 *  the raster path is the reference, which is why it shipped first (1gg0.10.3).
 *
 *  An identity chain is `offset` with dx = dy = 0 rather than a case of its
 *  own, so there is no extra branch for a consumer to forget. Same reasoning as
 *  FilterResolution above, applied in the other direction. */
export type FastPath =
  | { kind: 'offset'; dx: number; dy: number; clip: SegBBox }
  | { kind: 'flood'; color: Rgb; opacity: number; clip: SegBBox }
  | { kind: 'tint'; color: Rgb; opacity: number; clip: SegBBox };

/** flood-color x flood-opacity, or null when the flood paints nothing.
 *
 *  Mirrors floodKernel in svgfilterfx.ts exactly, including its treatment of
 *  'none' and of a value that will not parse. The two paths have to agree on
 *  precisely the inputs nobody writes a test for, so a flood that paints
 *  nothing returns null and rasterizes -- where the raster path already
 *  produces the same empty result -- rather than growing an emission whose only
 *  job is to draw nothing. */
function floodPaint(p: FilterPrim): { color: Rgb; opacity: number } | null {
  const c = parseColor(p.attrs.get('flood-color') ?? 'black');
  if (c === null || c === undefined) return null;
  const o = parseFloat(p.attrs.get('flood-opacity') ?? '1');
  const a = Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1;
  return { color: c, opacity: a };
}

/** Match a resolved graph against the fast-path table; null means rasterize.
 *
 *  Matching is on the RESOLVED prims, never on the source attributes.
 *  resolveFilter has already defaulted a missing `in` to SourceGraphic or to
 *  the previous result, and has already intersected every subregion with the
 *  filter region, so the spellings authors actually write need no special case
 *  here. */
export function classify(spec: FilterSpec): FastPath | null {
  const p = spec.prims;

  if (p.length === 1 && p[0].name === 'feOffset' && p[0].in1 === 'SourceGraphic')
    return {
      kind: 'offset',
      dx: primLength(spec, p[0].attrs.get('dx'), 0, 'x'),
      dy: primLength(spec, p[0].attrs.get('dy'), 0, 'y'),
      clip: p[0].sub,
    };

  // A one-node feMerge is a pass-through. An feMergeNode is NOT a primitive and
  // joins no implicit chain, so its missing `in` means SourceGraphic rather
  // than the previous result -- which is why this reads the child's own
  // attribute and not p[0].in1.
  if (p.length === 1 && p[0].name === 'feMerge') {
    const nodes = p[0].node.children.filter((c) => c.name === 'feMergeNode');
    if (nodes.length === 1
        && (nodes[0].attrs.get('in') ?? 'SourceGraphic') === 'SourceGraphic')
      return { kind: 'offset', dx: 0, dy: 0, clip: p[0].sub };
  }

  if (p.length === 1 && p[0].name === 'feFlood') {
    const f = floodPaint(p[0]);
    if (f !== null)
      return { kind: 'flood', color: f.color, opacity: f.opacity, clip: p[0].sub };
  }

  // feFlood -> feComposite operator="in" against the source's alpha: the
  // recolour-an-icon recipe, and the only chain here that real documents
  // contain. Exact in EITHER colour space, because a constant colour through an
  // alpha multiply round-trips linearRGB unchanged -- which is what qualifies
  // it where feBlend over a flood does not.
  //
  // `operator` is matched literally rather than defaulted: its default is
  // "over", which is a different picture.
  if (p.length === 2 && p[0].name === 'feFlood' && p[1].name === 'feComposite'
      && p[1].attrs.get('operator') === 'in'
      && p[1].in1 === p[0].result
      && (p[1].in2 === 'SourceAlpha' || p[1].in2 === 'SourceGraphic')) {
    const f = floodPaint(p[0]);
    if (f !== null)
      return { kind: 'tint', color: f.color, opacity: f.opacity,
               clip: clipTo(p[0].sub, p[1].sub) };
  }

  return null;
}

/** Resolve one `<filter>` against the element it filters. */
export function resolveFilter(
  node: XmlNode, bbox: SegBBox | null, viewport: ViewBox,
  css?: CssDecls, paint?: Paint, hasImageResolver = false,
): FilterResolution {
  const obb = (node.attrs.get('filterUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  // objectBoundingBox is the DEFAULT, so a missing or empty box is the common
  // failure, not an edge case. It cannot yield a region, and the element has
  // ink, so it degrades to unfiltered rather than to nothing.
  if (obb && (!bbox || !(bbox.w > 0) || !(bbox.h > 0)))
    return { kind: 'skip', report: ['filter'] };

  // The spec's defaults are the STRINGS -10%/-10%/120%/120%, so under
  // userSpaceOnUse they resolve against the viewport, not the box. Mirrors
  // resolveMask, which has the identical rule.
  const sx = obb ? bbox!.w : viewport.w;
  const sy = obb ? bbox!.h : viewport.h;
  const fx = unitLength(node.attrs.get('x'), obb ? -0.1 : -0.1 * sx, obb, sx);
  const fy = unitLength(node.attrs.get('y'), obb ? -0.1 : -0.1 * sy, obb, sy);
  const fw = unitLength(node.attrs.get('width'), obb ? 1.2 : 1.2 * sx, obb, sx);
  const fh = unitLength(node.attrs.get('height'), obb ? 1.2 : 1.2 * sy, obb, sy);
  // SVG 1.1 §15.7.2: a zero or negative extent disables rendering of the
  // ELEMENT. That is what the author asked for, so it is not a loss.
  if (!(fw > 0) || !(fh > 0)) return { kind: 'empty' };

  const region: SegBBox = obb
    ? { x: bbox!.x + fx * bbox!.w, y: bbox!.y + fy * bbox!.h,
        w: fw * bbox!.w, h: fh * bbox!.h }
    : { x: fx, y: fy, w: fw, h: fh };

  const kids = node.children.filter(isPrimitive);
  // No primitives means no result to draw. Not 'empty': an author writing an
  // empty <filter> has almost certainly lost the contents, so it is reported.
  if (kids.length === 0) return { kind: 'skip', report: ['filter'] };

  const pobb = node.attrs.get('primitiveUnits') === 'objectBoundingBox';
  const filterSpace = styleGetter(node.attrs, css)('color-interpolation-filters');
  const prims: FilterPrim[] = [];
  const results = new Set<string>();
  let prev = '';

  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!SUPPORTED.has(k.name)) return { kind: 'skip', report: [k.name] };

    // A malformed feConvolveMatrix cannot be guessed at: an order/kernelMatrix
    // mismatch, or a target outside the kernel, makes the whole chain refuse.
    if (k.name === 'feConvolveMatrix' && !validConvolve(k.attrs))
      return { kind: 'skip', report: ['feConvolveMatrix'] };

    // feImage resolves a same-document fragment or a data: URI. An external
    // href is refused for the same reason <image> refuses one: the library
    // performs no I/O, so the bytes have to arrive inside the document.
    if (k.name === 'feImage' && !validImageHref(k.attrs, hasImageResolver))
      return { kind: 'skip', report: ['feImage'] };

    // A lighting primitive with no light source has no defined result.
    if ((k.name === 'feDiffuseLighting' || k.name === 'feSpecularLighting')
        && !k.children.some((c) => c.name === 'feDistantLight'
                                || c.name === 'fePointLight' || c.name === 'feSpotLight'))
      return { kind: 'skip', report: [k.name] };

    const named = k.attrs.get('result');
    // Unnamed results get a key an author cannot collide with: 'result' is a
    // CDATA attribute, so a literal '#' is legal in it, but no one writes one.
    const result = named !== undefined && named !== '' ? named : `#${i}`;

    const in1 = k.attrs.get('in') ?? (prev === '' ? 'SourceGraphic' : prev);
    const in2 = k.attrs.get('in2') ?? '';
    for (const v of primInputs({ name: k.name, node: k, in1, in2 })) {
      if (v === '') continue;
      // A result is visible only to LATER primitives (SVG 1.1 §15.7.2), so
      // `results` is consulted before this primitive's own key is added.
      if (results.has(v)) continue;
      if (pseudoOk(v, paint)) continue;
      // Everything left is either a pseudo-input we cannot supply
      // (BackgroundImage, FillPaint) or a name nothing produced. Both report
      // 'filter': an author cannot act on the difference, and naming the
      // pseudo-input would read like a supported-primitive report.
      return { kind: 'skip', report: ['filter'] };
    }

    const cif = styleGetter(k.attrs, undefined)('color-interpolation-filters') ?? filterSpace;
    prims.push({
      name: k.name, in1, in2, result,
      sub: subregion(k.attrs, region, pobb, bbox),
      attrs: k.attrs, node: k,
      space: (cif ?? '').trim() === 'sRGB' ? 'sRGB' : 'linearRGB',
    });
    results.add(result);
    prev = result;
  }

  return {
    kind: 'draw',
    spec: {
      region, prims, obb: pobb, bbox, res: filterRes(node.attrs.get('filterRes')),
      paint: paint === undefined ? undefined : { fill: paint.fill, stroke: paint.stroke },
    },
  };
}
