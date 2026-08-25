// SVG <pattern> -> PDF PatternType 1 tiling pattern (issue 1gg0.19). Pure
// arithmetic: href inheritance, unit resolution and the tile geometry. Mirrors
// svggradient.ts's role for the other paint server; the two share no attributes
// and so share no code beyond the matrix helpers.
import type { XmlNode } from './xml.js';
import type { SegBBox } from './svgpath.js';
import {
  parseTransform, parseViewBox, unitLength, viewBoxFitDown, type ViewBox,
} from './svgtransform.js';
import { IDENTITY, mul, type Matrix } from './text.js';

/** A pattern flattened through its href chain: the effective attributes, and
 *  the element whose children supply the tile content. */
export interface ResolvedPattern {
  attrs: Map<string, string>;
  content: XmlNode;
}

/** Never inherited through href — they identify the reference itself. */
const NOT_INHERITED = new Set(['id', 'href', 'xlink:href']);

/** Flatten a pattern's `href` / `xlink:href` chain. Content is inherited when
 *  the referring element has none of its own, mirroring how a gradient inherits
 *  stops. A visited set breaks reference cycles. */
export function resolvePattern(
  node: XmlNode, ids: Map<string, XmlNode>,
): ResolvedPattern {
  const attrs = new Map(node.attrs);
  let content = node;
  const seen = new Set<string>();
  const selfId = node.attrs.get('id');
  if (selfId !== undefined) seen.add(selfId);

  let cur: XmlNode = node;
  for (;;) {
    const href = cur.attrs.get('href') ?? cur.attrs.get('xlink:href');
    if (href === undefined || href[0] !== '#') break;
    const id = href.slice(1);
    if (id === '' || seen.has(id)) break;
    seen.add(id);
    const next = ids.get(id);
    if (!next || next.name !== 'pattern') break;
    for (const [k, v] of next.attrs)
      if (!NOT_INHERITED.has(k) && !attrs.has(k)) attrs.set(k, v);
    if (content.children.length === 0) content = next;
    cur = next;
  }
  return { attrs, content };
}

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The tile rect in the enclosing user space, or null when it has no area —
 *  which SVG says means the element is simply not rendered by that paint. */
export function tileRect(
  attrs: Map<string, string>, obb: boolean, bbox: SegBBox | null, viewport: ViewBox,
): TileRect | null {
  // objectBoundingBox cannot place a tile on a box with no area, the same rule
  // gradients already follow.
  if (obb && (!bbox || !(bbox.w > 0) || !(bbox.h > 0))) return null;
  const sx = obb ? bbox!.w : viewport.w;
  const sy = obb ? bbox!.h : viewport.h;

  const fx = unitLength(attrs.get('x'), 0, obb, sx);
  const fy = unitLength(attrs.get('y'), 0, obb, sy);
  const fw = unitLength(attrs.get('width'), 0, obb, sx);
  const fh = unitLength(attrs.get('height'), 0, obb, sy);
  if (!(fw > 0) || !(fh > 0)) return null;

  return obb
    ? { x: bbox!.x + fx * bbox!.w, y: bbox!.y + fy * bbox!.h,
        w: fw * bbox!.w, h: fh * bbox!.h }
    : { x: fx, y: fy, w: fw, h: fh };
}

/** The pattern `/Matrix` and the transform the tile's own content needs.
 *
 *  `/Matrix` maps pattern space to the enclosing content stream's default
 *  space — which in this stack is y-down, exactly as gradients assume, so no
 *  flip belongs here. patternTransform applies INSIDE pattern space and is
 *  therefore the leftmost factor, matching gradientTransform's order.
 *
 *  The content transform is returned SEPARATELY rather than folded in, because
 *  /BBox and /XStep are expressed in pattern space: folding a viewBox scale
 *  into /Matrix would scale the tile spacing along with the artwork. */
export function tileMatrix(
  attrs: Map<string, string>, rect: TileRect, obb: boolean,
  bbox: SegBBox | null, ctm: Matrix,
): { matrix: Matrix; content: Matrix } {
  const pt = parseTransform(attrs.get('patternTransform'));
  const place: Matrix = [1, 0, 0, 1, rect.x, rect.y];
  const matrix = mul(mul(pt, place), ctm);
  void obb;

  const vb = parseViewBox(attrs.get('viewBox'));
  if (vb) {
    // A viewBox overrides patternContentUnits entirely (SVG 1.1 §13.3).
    // /Matrix has already placed the tile, so fit into a box at the origin.
    return {
      matrix,
      content: viewBoxFitDown(vb, rect.w, rect.h, attrs.get('preserveAspectRatio')),
    };
  }

  const ccu = attrs.get('patternContentUnits') === 'objectBoundingBox';
  const content: Matrix = ccu && bbox
    ? [bbox.w, 0, 0, bbox.h, 0, 0]
    : [...IDENTITY];
  return { matrix, content };
}
