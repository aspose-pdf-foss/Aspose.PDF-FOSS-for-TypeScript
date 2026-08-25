// SVG <textPath method="stretch"> (issue 1gg0.25): warp glyph OUTLINES along
// the curve rather than placing upright glyphs at tangent angles. Pure — no
// Document, no PDF objects, no font parsing. Outlines arrive through
// SvgFace.outline, which svgembed.ts fills in, mirroring how fonts already
// arrive through SvgFontProvider.
import { mul } from './text.js';
import type { Poly } from './strokegeom.js';
import type { SvgSeg } from './svgpath.js';
import { textMatrix, type PlacedGlyph, type SvgTextStyle } from './svgtext.js';
import { pointAt, placeAt, type PathMetrics } from './svgtextpath.js';

/** One warped run: contours in the <text> element's user space, plus the style
 *  whose paint fills them. One per contiguous style, mirroring emitGlyphs' runs
 *  so a <tspan> inside a stretched <textPath> gets its own paint. */
export interface StretchedRun {
  segs: SvgSeg[];
  style: SvgTextStyle;
}

/** Whether every glyph `onPath` selects can supply an outline, and there is at
 *  least one.
 *
 *  All-or-nothing per textPath, deliberately: a run mixing a face that can
 *  stretch with one that cannot would render half its glyphs warped and half
 *  upright, which reads as a bug rather than as a degradation. */
export function canStretch(
  glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean,
): boolean {
  let any = false;
  for (const g of glyphs) {
    if (!onPath(g)) continue;
    if (g.style.face.outline === undefined) return false;
    any = true;
  }
  return any;
}

/** Warp every glyph `onPath` selects onto `m`.
 *
 *  MUST run before mapGlyphsToPath, which mutates g.x/g.y in place: the warp
 *  reads the chunk-local layout positions, where x is distance along the run.
 *
 *  Which glyphs render is the same midpoint rule mapGlyphsToPath applies, so
 *  the warped ink and the invisible text layer agree about what exists. Within
 *  a surviving glyph, per-point distances CLAMP to the path's extent: deciding
 *  per point instead would tear a glyph in half at the boundary. */
export function stretchGlyphs(
  glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean,
  m: PathMetrics, startOffset: number, tol: number,
): StretchedRun[] {
  const runs: StretchedRun[] = [];
  let cur: StretchedRun | undefined;

  for (const g of glyphs) {
    if (!onPath(g)) { cur = undefined; continue; }
    // The same midpoint test mapGlyphsToPath uses to drop a glyph.
    if (pointAt(m, startOffset + g.x + g.adv / 2) === null) continue;

    // Em units to the run's chunk-local user space: the SAME placement
    // emitGlyphs builds its Tm from, so rotate=, lengthAdjust's hscale, dy and
    // baseline-shift all reach the warp without a second implementation.
    const em = mul(
      [g.style.size * g.hscale, 0, 0, g.style.size, 0, 0],
      textMatrix(g.x, g.y, g.rot),
    );
    const polys = g.style.face.outline?.(g.ch, em, tol);
    if (!polys || polys.length === 0) continue;     // blank or missing glyph

    if (cur === undefined || cur.style !== g.style) {
      cur = { segs: [], style: g.style };
      runs.push(cur);
    }
    for (const poly of polys) {
      const warped = warpPoly(poly, m, startOffset);
      if (warped !== null) cur.segs.push(...warped);
    }
  }
  return runs;
}

/** One contour warped onto the path as an M/L/.../Z subpath, or null when the
 *  path has no extent (placeAt cannot answer). */
function warpPoly(poly: Poly, m: PathMetrics, startOffset: number): SvgSeg[] | null {
  const segs: SvgSeg[] = [];
  for (let i = 0; i + 1 < poly.length; i += 2) {
    const d = startOffset + poly[i];
    const p = placeAt(m, Math.min(Math.max(d, 0), m.total), poly[i + 1]);
    if (p === null) return null;
    segs.push({ op: segs.length === 0 ? 'M' : 'L', args: [p.x, p.y] });
  }
  if (segs.length < 2) return null;
  segs.push({ op: 'Z', args: [] });
  return segs;
}
