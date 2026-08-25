import type { SvgFontProvider } from '../../src/svgtext.js';
import { vmetricsFor } from '../../src/textdecor.js';
import { name, type PdfObject } from '../../src/types.js';
import { apply, type Matrix } from '../../src/text.js';
import type { Poly } from '../../src/strokegeom.js';

/** A unit square sitting on the baseline, in em units: (0,0) to (1,1) y-up.
 *  Predictable geometry, so a warped result can be asserted in closed form
 *  rather than compared against a real face's contours. */
function squareOutline(ch: string, m: Matrix): Poly[] {
  if (ch === ' ') return [];                       // blank glyph: real, but no ink
  const poly: Poly = [];
  for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) poly.push(...apply(m, x, y));
  return [poly];
}

/** A font provider whose every glyph is exactly 1 em wide, so expected
 *  positions in the layout tests are readable integers rather than AFM widths.
 *  It records the family lists it was asked for.
 *
 *  Shared by the svgtext and svgdraw suites: both need a provider, and neither
 *  is testing font metrics.
 *
 *  `outline` is OPT-IN and off by default: a face without it is what makes
 *  textPath method="stretch" fall back to align, so every existing test keeps
 *  exercising that path. */
export function fakeProvider(opts: { outline?: boolean } = {}):
  SvgFontProvider & { asks: string[][] } {
  const asks: string[][] = [];
  // Real entries, so buildResources can filter the used keys against them.
  const fonts = new Map<string, PdfObject>();
  return {
    asks,
    dict: () => fonts,
    face(families, bold, italic) {
      asks.push(families);
      const key = `F${bold ? 'B' : ''}${italic ? 'I' : ''}`;
      if (!fonts.has(key)) fonts.set(key, name(key));
      return {
        key,
        driver: {
          measure: (t: string, fs: number) => t.length * fs,
          encode: (t: string) => new TextEncoder().encode(t),
          probe: (t: string) => t.length,
        },
        vmetrics: vmetricsFor('Helvetica'),
        ...(opts.outline ? { outline: (ch: string, m: Matrix) => squareOutline(ch, m) } : {}),
      };
    },
  };
}
