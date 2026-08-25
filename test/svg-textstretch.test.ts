import { describe, it, expect } from 'vitest';
import { flattenText, layoutText } from '../src/svgtext.js';
import { measurePath } from '../src/svgtextpath.js';
import { canStretch, stretchGlyphs } from '../src/svgtextstretch.js';
import { parsePath, type SvgSeg } from '../src/svgpath.js';
import { parseXml } from '../src/xml.js';
import { INITIAL } from '../src/svgstyle.js';
import { FLATTEN_TOL } from '../src/strokegeom.js';
import { fakeProvider } from './helpers/fake-svg-font.js';

const xml = (s: string) => new TextEncoder().encode(s);
const lay = (src: string, outline = true) =>
  layoutText(flattenText(parseXml(xml(src)), INITIAL, fakeProvider({ outline }), 12));
const metrics = (d: string) => measurePath(parsePath(d).segs);
const all = () => true;

/** Bounds of one run's segs. */
function bounds(segs: SvgSeg[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) {
    if (s.args.length < 2) continue;
    x0 = Math.min(x0, s.args[0]); x1 = Math.max(x1, s.args[0]);
    y0 = Math.min(y0, s.args[1]); y1 = Math.max(y1, s.args[1]);
  }
  return { x0, y0, x1, y1 };
}

describe('canStretch', () => {
  it('is false when any face on the path has no outline', () => {
    expect(canStretch(lay('<text>ab</text>', false), all)).toBe(false);
  });

  it('is true when every face on the path has one', () => {
    expect(canStretch(lay('<text>ab</text>'), all)).toBe(true);
  });

  it('is false when no glyph is on the path at all', () => {
    expect(canStretch(lay('<text>ab</text>'), () => false)).toBe(false);
  });
});

describe('stretchGlyphs', () => {
  // Straight down from (100,20): the tangent is +90 degrees everywhere, so the
  // mapping is exact. A glyph's advance runs along +y and its own "up" (-y in
  // user space, an em box of height `size`) runs along +x.
  const DOWN = metrics('M100 20 L100 180');

  it('maps a run onto the path in closed form', () => {
    // Every glyph is 1 em wide at font-size 10, so glyph 0 spans run-distance
    // 0..10 and glyph 1 spans 10..20.
    const runs = stretchGlyphs(lay('<text font-size="10">ab</text>'), all, DOWN, 0, FLATTEN_TOL);
    expect(runs).toHaveLength(1);
    const b = bounds(runs[0].segs);
    expect(b.x0).toBeCloseTo(100, 6);
    expect(b.x1).toBeCloseTo(110, 6);      // one em of glyph height, mapped to +x
    expect(b.y0).toBeCloseTo(20, 6);
    expect(b.y1).toBeCloseTo(40, 6);       // two glyphs of advance, mapped to +y
  });

  it('honours startOffset along the path', () => {
    const runs = stretchGlyphs(lay('<text font-size="10">a</text>'), all, DOWN, 25, FLATTEN_TOL);
    const b = bounds(runs[0].segs);
    expect(b.y0).toBeCloseTo(45, 6);
    expect(b.y1).toBeCloseTo(55, 6);
  });

  it('keeps the perpendicular extent — the glyph is not collapsed to the curve', () => {
    // The assertion that fails if the perp term is dropped from the mapping:
    // without it every point lands ON the path and the box has zero width.
    const runs = stretchGlyphs(lay('<text font-size="10">a</text>'), all, DOWN, 0, FLATTEN_TOL);
    const b = bounds(runs[0].segs);
    expect(b.x1 - b.x0).toBeCloseTo(10, 6);
  });

  it('turns with the path: a semicircle reverses the glyph-up direction', () => {
    // Radius 80, so the arc is pi*80 ~= 251 units long. The run must SPAN it for
    // the first and last glyph to be half a turn apart: 25 glyphs of 1 em at
    // font-size 10 cover 250 of those units. A shorter run only proves the
    // tangent turns a little, which a coarse approximation could also pass.
    const arc = metrics('M20 100 A80 80 0 0 1 180 100');
    const runs = stretchGlyphs(lay(`<text font-size="10">${'a'.repeat(25)}</text>`), all, arc, 0, FLATTEN_TOL);
    const segs = runs[0].segs;
    // Each glyph contributes M,L,L,L,Z. Within one glyph, index 0 is the
    // baseline-left corner and index 3 is the same corner one em UP, so their
    // difference is the glyph-up vector at that point on the arc.
    const upAt = (i: number) => {
      const o = i * 5;
      return [segs[o + 3].args[0] - segs[o].args[0], segs[o + 3].args[1] - segs[o].args[1]];
    };
    const [ax, ay] = upAt(0);
    const [bx, by] = upAt(24);
    const dot = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
    expect(dot).toBeLessThan(-0.9);        // ~180 degrees apart
  });

  it('drops a glyph whose midpoint falls past the end of the path', () => {
    const short = metrics('M0 0 L0 12');   // room for one 10-unit glyph, not two
    const runs = stretchGlyphs(lay('<text font-size="10">ab</text>'), all, short, 0, FLATTEN_TOL);
    expect(runs[0].segs.filter((s) => s.op === 'M')).toHaveLength(1);
  });

  it('starts a new run at a style change', () => {
    const runs = stretchGlyphs(
      lay('<text font-size="10">a<tspan fill="red">b</tspan></text>'), all, DOWN, 0, FLATTEN_TOL);
    expect(runs).toHaveLength(2);
  });

  it('contributes no geometry for a blank glyph', () => {
    const runs = stretchGlyphs(
      lay('<text xml:space="preserve" font-size="10">a b</text>'), all, DOWN, 0, FLATTEN_TOL);
    expect(runs[0].segs.filter((s) => s.op === 'M')).toHaveLength(2);
  });
});
