// SVG <mask> -> PDF soft mask (issue 1gg0.10). Pure arithmetic: region and
// content unit resolution, and the luminosity-vs-alpha choice. Mirrors
// svgpattern.ts's role for the other referenced definition — it decides
// geometry and hands back a descriptor, allocating nothing.
import type { XmlNode } from './xml.js';
import type { SegBBox } from './svgpath.js';
import { unitLength, type ViewBox } from './svgtransform.js';
import { IDENTITY, type Matrix } from './text.js';
import { styleGetter } from './svgstyle.js';
import type { CssDecls } from './svgcss.js';

/** A resolved <mask>: where it applies, how its content is interpreted, and
 *  which PDF soft-mask subtype it becomes. */
export interface MaskSpec {
  /** The mask region, in the masked element's user space. Becomes the mask
   *  group's /BBox — which is exact, not a crop: SVG 1.1 §14.4 makes the
   *  element fully transparent outside the region anyway. */
  region: SegBBox;
  /** Prepended to the mask content. Identity unless maskContentUnits is
   *  objectBoundingBox. */
  content: Matrix;
  /** The /SMask /S subtype. */
  type: 'Luminosity' | 'Alpha';
}

/** Resolve one `<mask>` against the element it masks.
 *
 *  Returns null when the mask cannot apply: a region with no area, or
 *  objectBoundingBox units on a box with no area — the same rule tileRect
 *  follows for a pattern. The caller draws unmasked and reports. */
export function resolveMask(
  node: XmlNode, bbox: SegBBox | null, viewport: ViewBox, css?: CssDecls,
): MaskSpec | null {
  const get = styleGetter(node.attrs, css);
  const obb = (node.attrs.get('maskUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  if (obb && (!bbox || !(bbox.w > 0) || !(bbox.h > 0))) return null;

  // The spec's defaults are the STRINGS -10%/-10%/120%/120%, so under
  // userSpaceOnUse they resolve against the viewport, not the box.
  const sx = obb ? bbox!.w : viewport.w;
  const sy = obb ? bbox!.h : viewport.h;
  const fx = unitLength(node.attrs.get('x'), obb ? -0.1 : -0.1 * sx, obb, sx);
  const fy = unitLength(node.attrs.get('y'), obb ? -0.1 : -0.1 * sy, obb, sy);
  const fw = unitLength(node.attrs.get('width'), obb ? 1.2 : 1.2 * sx, obb, sx);
  const fh = unitLength(node.attrs.get('height'), obb ? 1.2 : 1.2 * sy, obb, sy);
  if (!(fw > 0) || !(fh > 0)) return null;

  const region: SegBBox = obb
    ? { x: bbox!.x + fx * bbox!.w, y: bbox!.y + fy * bbox!.h,
        w: fw * bbox!.w, h: fh * bbox!.h }
    : { x: fx, y: fy, w: fw, h: fh };

  // Unlike patternContentUnits, this carries the translate: /Matrix has not
  // already placed the content.
  const ccu = node.attrs.get('maskContentUnits') === 'objectBoundingBox';
  const content: Matrix = ccu && bbox
    ? [bbox.w, 0, 0, bbox.h, bbox.x, bbox.y]
    : [...IDENTITY];

  const mode = (get('mask-type') ?? get('mask-mode') ?? '').trim().toLowerCase();
  return { region, content, type: mode === 'alpha' ? 'Alpha' : 'Luminosity' };
}
