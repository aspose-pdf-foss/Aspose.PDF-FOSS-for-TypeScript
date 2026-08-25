// Glyph outlines to polylines. Shared: raster.ts fills them to paint text, and
// the SVG authoring stack warps them along a <textPath method="stretch">.
// Kept out of raster.ts so the authoring side needs no dependency on the
// rasterizer, and so one flattener serves both — the rule flattenCubic already
// embodies for cubics.
import { Matrix, apply, mul } from './text.js';
import { Poly, MAX_SUBDIV, FLATTEN_TOL, flattenPath } from './strokegeom.js';
import type { GlyphPoint, SfntFont } from './sfnt.js';
import type { Path } from './pagerender.js';
import { CffFont } from './cff.js';
import { Type1Font } from './type1.js';

/** Flatten a quadratic Bézier to `out` by adaptive subdivision. */
function flattenQuad(
  out: Poly, x0: number, y0: number, cx: number, cy: number,
  x1: number, y1: number, depth: number, tol: number,
): void {
  if (depth >= MAX_SUBDIV) { out.push(x1, y1); return; }
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.abs((cx - x1) * dy - (cy - y1) * dx);
  if (dist * dist <= tol * tol * (dx * dx + dy * dy)) { out.push(x1, y1); return; }
  const x01 = (x0 + cx) / 2, y01 = (y0 + cy) / 2, x12 = (cx + x1) / 2, y12 = (cy + y1) / 2;
  const xm = (x01 + x12) / 2, ym = (y01 + y12) / 2;
  flattenQuad(out, x0, y0, x01, y01, xm, ym, depth + 1, tol);
  flattenQuad(out, xm, ym, x12, y12, x1, y1, depth + 1, tol);
}

/** Flatten TrueType quadratic contours to polylines under `m` (font→target).
 *  Reconstructs on/off-curve sequences (implied midpoints, off-curve starts). */
export function flattenGlyphContours(
  contours: GlyphPoint[][], m: Matrix, tol = FLATTEN_TOL,
): Poly[] {
  const polys: Poly[] = [];
  for (const contour of contours) {
    const n = contour.length;
    if (n < 2) continue;
    const dp = contour.map((pt) => { const [x, y] = apply(m, pt.x, pt.y); return { x, y, on: pt.on }; });
    let startIdx = dp.findIndex((p) => p.on);
    let start: { x: number; y: number };
    const seq: { x: number; y: number; on: boolean }[] = [];
    if (startIdx >= 0) {
      start = dp[startIdx];
      for (let k = 1; k <= n; k++) seq.push(dp[(startIdx + k) % n]);
    } else {
      start = { x: (dp[0].x + dp[n - 1].x) / 2, y: (dp[0].y + dp[n - 1].y) / 2 };
      for (const p of dp) seq.push(p);
      seq.push({ x: start.x, y: start.y, on: true });
    }
    const poly: Poly = [start.x, start.y];
    let curx = start.x, cury = start.y;
    let ctrl: { x: number; y: number } | undefined;
    for (const p of seq) {
      if (p.on) {
        if (ctrl) { flattenQuad(poly, curx, cury, ctrl.x, ctrl.y, p.x, p.y, 0, tol); ctrl = undefined; }
        else poly.push(p.x, p.y);
        curx = p.x; cury = p.y;
      } else if (ctrl) {
        const mx = (ctrl.x + p.x) / 2, my = (ctrl.y + p.y) / 2;
        flattenQuad(poly, curx, cury, ctrl.x, ctrl.y, mx, my, 0, tol);
        curx = mx; cury = my; ctrl = p;
      } else ctrl = p;
    }
    if (ctrl) flattenQuad(poly, curx, cury, ctrl.x, ctrl.y, start.x, start.y, 0, tol);
    if (poly.length >= 6) polys.push(poly);
  }
  return polys;
}

/** What {@link glyphPolys} needs from a charstring-based font program. `CffFont`
 *  and `Type1Font` both satisfy it structurally, so the two share one branch
 *  below rather than two copies of the same four lines. */
export interface CharstringProgram {
  readonly unitsPerEm: number;
  glyphPath(gid: number): Path;
}

/** Where a glyph's outline comes from. A charstring program wins when both are
 *  present: an OpenType-CFF face has an sfnt wrapper whose glyf table is absent. */
export interface OutlineSource {
  sfnt?: SfntFont;
  cff?: CffFont;
  type1?: Type1Font;
}

/** Glyph `gid` as polylines under `m`, which maps EM units (y-up) to the target
 *  space — the font's own unitsPerEm is divided out here, so callers never see
 *  font units. Empty for a blank glyph, a missing one, or no source. */
export function glyphPolys(
  src: OutlineSource, gid: number, m: Matrix, tol = FLATTEN_TOL,
): Poly[] {
  const prog: CharstringProgram | undefined = src.cff ?? src.type1;
  if (prog) {
    const path = prog.glyphPath(gid);
    if (path.length === 0) return [];
    const upm = prog.unitsPerEm || 1000;
    return flattenPath(path, mul([1 / upm, 0, 0, 1 / upm, 0, 0], m), tol);
  }
  if (src.sfnt) {
    const contours = src.sfnt.glyphOutline(gid);
    if (contours.length === 0) return [];
    const upm = src.sfnt.unitsPerEm || 1000;
    return flattenGlyphContours(contours, mul([1 / upm, 0, 0, 1 / upm, 0, 0], m), tol);
  }
  return [];
}

/** A per-character outline reader for one face, for SvgFace.outline.
 *
 *  The CFF table is parsed at most once, on the first character that needs it:
 *  an OpenType-CFF face carries its outlines there rather than in `glyf`, and
 *  parsing it eagerly would cost every face that never stretches. */
export function faceOutline(
  sfnt: SfntFont,
): (ch: string, m: Matrix, tol: number) => Poly[] | null {
  let src: OutlineSource | undefined;
  return (ch, m, tol) => {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return null;
    const gid = sfnt.cmapLookup(cp);
    if (gid === undefined) return null;             // no glyph: caller falls back
    if (src === undefined) {
      if (sfnt.outlines === 'cff') {
        const raw = sfnt.table('CFF ', false);
        let cff: CffFont | undefined;
        // A malformed CFF is a broken font, not a broken document: report no
        // outline and let the caller degrade, exactly as a missing glyph does.
        if (raw) { try { cff = new CffFont(raw); } catch { cff = undefined; } }
        src = { cff };
      } else {
        src = { sfnt };
      }
    }
    if (src.cff === undefined && src.sfnt === undefined) return null;
    return glyphPolys(src, gid, m, tol);
  };
}
