import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { resolveFilter, type FilterResolution, type FilterSpec } from '../src/svgfilter.js';
import { makeSurface, runFilter, srgbToLinear, type Surface } from '../src/svgfilterfx.js';
import { INITIAL, type Paint } from '../src/svgstyle.js';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const xml = (s: string) => new TextEncoder().encode(s);
const near = (a: number, b: number, d = 5) => expect(a).toBeCloseTo(b, d);

/** A mid-tone, and it has to be. srgbToLinear fixes 0 and 1, so #ff0000,
 *  #ffffff and #000000 all survive the linearization being DELETED and cannot
 *  test the seed at all. #996633 = (0x99, 0x66, 0x33). */
const MID: [number, number, number] = [0x99 / 255, 0x66 / 255, 0x33 / 255];

const VP = { minX: 0, minY: 0, w: 100, h: 100 };

/** resolveFilter over a 10x10 user-space region, so at scale 1 one user unit is
 *  one pixel and every pixel expectation below reads directly. */
function resolve(prims: string, paint: Paint | undefined): FilterResolution {
  const root = parseXml(xml(
    '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
    `width="10" height="10">${prims}</filter></svg>`));
  let f: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.name === 'filter') f ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return resolveFilter(f!, { x: 0, y: 0, w: 10, h: 10 }, VP, undefined, paint);
}

/** resolve(), asserting it resolved, with `p` overriding INITIAL. */
function specWith(prims: string, p: Partial<Paint>): FilterSpec {
  const r = resolve(prims, { ...INITIAL, ...p });
  if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
  return r.spec;
}

/** A 10x10 source: opaque white in the top-left 2x2, transparent elsewhere. */
function source(): Surface {
  const s = makeSurface(0, 0, 10, 10);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const i = (y * 10 + x) * 4;
    s.data[i] = 1; s.data[i + 1] = 1; s.data[i + 2] = 1; s.data[i + 3] = 1;
  }
  return s;
}

const px = (s: Surface, x: number, y: number): number[] =>
  [...s.data.slice((y * s.w + x) * 4, (y * s.w + x) * 4 + 4)];

/** Keep the whole plane: feMerge of one node is a pass-through. */
const MERGE = (input: string) => `<feMerge><feMergeNode in="${input}"/></feMerge>`;
const TINT = '<feComposite in="FillPaint" in2="SourceAlpha" operator="in"/>';

describe('resolveFilter — FillPaint/StrokePaint acceptance', () => {
  const solid: Paint = { ...INITIAL, fill: [1, 0, 0], stroke: [0, 0, 1] };

  it('accepts FillPaint when the caller supplies solid paint', () => {
    expect(resolve(TINT, solid).kind).toBe('draw');
  });

  it('refuses FillPaint when no paint is supplied', () => {
    // Every caller before 1gg0.10.6 passed four arguments and must keep
    // refusing. Accepting here would seed nothing and paint a transparent
    // plane as if it were ink.
    expect(resolve(TINT, undefined)).toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('refuses FillPaint for a gradient or pattern fill', () => {
    expect(resolve(TINT, { ...INITIAL, fillRef: 'g' }))
      .toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('accepts fill="none": a transparent plane is well defined', () => {
    expect(resolve(TINT, { ...INITIAL, fill: null }).kind).toBe('draw');
  });

  it('accepts StrokePaint on an element that never set a stroke', () => {
    // SVG's initial stroke IS none, so this is the common case, not an edge
    // one. Refusing it would put StrokePaint out of reach of most elements.
    expect(resolve(MERGE('StrokePaint'), INITIAL).kind).toBe('draw');
  });

  it('refuses StrokePaint for a gradient stroke', () => {
    expect(resolve(MERGE('StrokePaint'), { ...INITIAL, strokeRef: 'g' }))
      .toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('still refuses BackgroundImage, paint or no paint', () => {
    // It needs the accumulated page backdrop, which a single-pass walker does
    // not retain. Supplying paint must not widen the gate to everything.
    expect(resolve(MERGE('BackgroundImage'), solid))
      .toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('validates the inputs named on feMergeNode children', () => {
    // Not about paint: an feMerge carries no `in` of its own, so validating
    // only the primitive's in1/in2 let it name ANYTHING -- here a result no
    // primitive produced -- and still resolve as runnable, then silently yield
    // a transparent surface. Pre-existing; surfaced by routing FillPaint
    // through the idiomatic feMerge spelling.
    expect(resolve(MERGE('nosuchresult'), solid))
      .toEqual({ kind: 'skip', report: ['filter'] });
  });

  it('still accepts an feMergeNode naming an earlier result', () => {
    // The guard must not overshoot: a result IS visible to later primitives.
    expect(resolve('<feOffset dx="1" result="a"/>' + MERGE('a'), solid).kind).toBe('draw');
  });

  it('carries only the two colours onto the spec', () => {
    const r = resolve(TINT, solid);
    if (r.kind !== 'draw') throw new Error('expected draw');
    expect(r.spec.paint).toEqual({ fill: [1, 0, 0], stroke: [0, 0, 1] });
  });

  it('leaves spec.paint absent when the caller supplied none', () => {
    const r = resolve(MERGE('SourceGraphic'), undefined);
    if (r.kind !== 'draw') throw new Error('expected draw');
    expect(r.spec.paint).toBeUndefined();
  });
});

describe('runFilter — the paint planes', () => {
  it('seeds FillPaint as an opaque LINEAR plane', () => {
    const out = runFilter(specWith(MERGE('FillPaint'), { fill: MID }), source(), 1);
    // Linear, not sRGB. With the conversion deleted these read MID directly —
    // 0.6 vs 0.318 at the red channel, nowhere near the tolerance.
    near(px(out, 5, 5)[0], srgbToLinear(MID[0]));
    near(px(out, 5, 5)[1], srgbToLinear(MID[1]));
    near(px(out, 5, 5)[2], srgbToLinear(MID[2]));
    near(px(out, 5, 5)[3], 1);
  });

  it('covers the whole region, not just where the source has ink', () => {
    const out = runFilter(specWith(MERGE('FillPaint'), { fill: MID }), source(), 1);
    // The far corner: the source is transparent there, the plane is not.
    near(px(out, 9, 9)[3], 1);
  });

  it('does not swap the fill and stroke planes', () => {
    const out = runFilter(
      specWith(MERGE('StrokePaint'), { fill: [1, 0, 0], stroke: MID }), source(), 1);
    near(px(out, 5, 5)[0], srgbToLinear(MID[0]));
    near(px(out, 5, 5)[1], srgbToLinear(MID[1]));
  });

  it('makes a `none` paint a fully transparent plane', () => {
    const out = runFilter(
      specWith(MERGE('StrokePaint'), { fill: MID, stroke: null }), source(), 1);
    near(px(out, 5, 5)[3], 0);
  });

  it('composites the plane through the source alpha', () => {
    const out = runFilter(specWith(TINT, { fill: MID }), source(), 1);
    near(px(out, 0, 0)[0], srgbToLinear(MID[0]));   // inside the 2x2 silhouette
    near(px(out, 0, 0)[3], 1);
    near(px(out, 5, 5)[3], 0);                      // outside it: operator="in"
  });
});

/** Place `src` over a 200x200 page at 1 px per point and rasterize it. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(xml(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), result: r };
}

/** A shape carrying `style`, filtered by `prims`, over a user-space region
 *  covering the whole viewBox. */
const page = (prims: string, style: string) =>
  '<svg viewBox="0 0 200 200"><defs>' +
  '<linearGradient id="g"><stop offset="0" stop-color="#f00"/>' +
  '<stop offset="1" stop-color="#00f"/></linearGradient>' +
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
  prims + '</filter></defs>' +
  `<rect x="20" y="20" width="60" height="60" ${style} filter="url(#f)"/></svg>`;

describe('AddSVGObject — FillPaint through the whole stack', () => {
  it("floods the region with the element's own fill colour", () => {
    const { png, result } = render(page(MERGE('FillPaint'), 'fill="#996633"'));
    expect(result.skipped).toEqual([]);
    expect(result.rasterized).toEqual(['filter']);
    // A mid-tone, so a missing linearization anywhere in the stack shows up.
    // Well away from the rect, to prove the plane covers the whole region.
    const [r, g, b] = png.at(150, 150);
    expect(Math.abs(r - 0x99)).toBeLessThan(12);
    expect(Math.abs(g - 0x66)).toBeLessThan(12);
    expect(Math.abs(b - 0x33)).toBeLessThan(12);
  });

  it('ignores fill-opacity: the plane is the paint, not the painted result', () => {
    // SVG 15.7.3 defines FillPaint as the value of the FILL PROPERTY, and
    // fill-opacity is a separate property. Fold it in and this pixel washes
    // out toward the white page.
    const { png } = render(page(MERGE('FillPaint'), 'fill="#996633" fill-opacity="0.4"'));
    const [r, g, b] = png.at(150, 150);
    expect(Math.abs(r - 0x99)).toBeLessThan(12);
    expect(Math.abs(g - 0x66)).toBeLessThan(12);
    expect(Math.abs(b - 0x33)).toBeLessThan(12);
  });

  it("floods with the element's stroke colour for StrokePaint", () => {
    const { png } = render(page(MERGE('StrokePaint'), 'fill="#ff0000" stroke="#996633"'));
    const [r, g, b] = png.at(150, 150);
    expect(Math.abs(r - 0x99)).toBeLessThan(12);
    expect(Math.abs(g - 0x66)).toBeLessThan(12);
    expect(Math.abs(b - 0x33)).toBeLessThan(12);
  });

  it('draws unfiltered and reports for a gradient fill', () => {
    const { png, result } = render(page(MERGE('FillPaint'), 'fill="url(#g)"'));
    expect(result.skipped).toEqual(['filter']);
    expect(result.rasterized).toEqual([]);
    // The gradient itself, unfiltered: red at the rect's left edge.
    expect(png.at(25, 50)[0]).toBeGreaterThan(150);
    // And nothing flooded the region.
    expect(png.at(150, 150)[0]).toBeGreaterThan(240);
  });
});
