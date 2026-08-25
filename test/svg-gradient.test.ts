import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import {
  resolveGradient, gradientPaint, spreadRange, tileStops, radialSpreadRange,
} from '../src/svggradient.js';
import {
  normalizeStops, stopsFunction, ALPHA, type GradientStop,
} from '../src/gradient.js';
import type { PdfDict } from '../src/types.js';
import type { SegBBox } from '../src/svgpath.js';
import type { ViewBox } from '../src/svgtransform.js';
import { IDENTITY, type Matrix } from '../src/text.js';

/** Parse an <svg> body and index every element carrying an id. */
function ids(svg: string): Map<string, XmlNode> {
  const root = parseXml(new TextEncoder().encode(svg));
  const m = new Map<string, XmlNode>();
  const visit = (n: XmlNode): void => {
    const id = n.attrs.get('id');
    if (id !== undefined && !m.has(id)) m.set(id, n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return m;
}

const grad = (svg: string, id: string) => {
  const map = ids(svg);
  return resolveGradient(map.get(id)!, map);
};

describe('resolveGradient — stops', () => {
  it('parses offsets, colours and opacities', () => {
    const g = grad('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red"/>' +
      '<stop offset="0.5" stop-color="#0f0" stop-opacity="0.5"/>' +
      '<stop offset="100%" stop-color="blue"/>' +
      '</linearGradient></svg>', 'g');
    expect(g.kind).toBe('linear');
    expect(g.stops).toEqual([
      { offset: 0, color: [1, 0, 0], opacity: 1 },
      { offset: 0.5, color: [0, 1, 0], opacity: 0.5 },
      { offset: 1, color: [0, 0, 1], opacity: 1 },
    ]);
  });

  it('takes stop properties through the style= cascade', () => {
    const g = grad('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" style="stop-color: blue; stop-opacity: 0.25"/>' +
      '</linearGradient></svg>', 'g');
    expect(g.stops[0].color).toEqual([0, 0, 1]);
    expect(g.stops[0].opacity).toBe(0.25);
  });

  it('defaults a missing stop-color to black and resolves currentColor to black', () => {
    const g = grad('<svg><linearGradient id="g">' +
      '<stop offset="0"/>' +
      '<stop offset="1" stop-color="currentColor"/>' +
      '</linearGradient></svg>', 'g');
    expect(g.stops[0].color).toEqual([0, 0, 0]);
    expect(g.stops[1].color).toEqual([0, 0, 0]);
  });

  it('clamps offsets into [0, 1] and ignores non-stop children', () => {
    const g = grad('<svg><linearGradient id="g"><desc>x</desc>' +
      '<stop offset="-3" stop-color="red"/>' +
      '<stop offset="7" stop-color="blue"/>' +
      '</linearGradient></svg>', 'g');
    expect(g.stops.map((s) => s.offset)).toEqual([0, 1]);
  });

  it('reports a radial gradient as radial', () => {
    expect(grad('<svg><radialGradient id="g"/></svg>', 'g').kind).toBe('radial');
  });
});

describe('resolveGradient — href reuse', () => {
  const SVG =
    '<svg><defs>' +
    '<linearGradient id="base" gradientUnits="userSpaceOnUse" spreadMethod="reflect" x1="1">' +
    '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>' +
    '</linearGradient>' +
    '<linearGradient id="own" href="#base" x1="9">' +
    '<stop offset="0" stop-color="lime"/><stop offset="1" stop-color="black"/>' +
    '</linearGradient>' +
    '<linearGradient id="inherit" href="#base"/>' +
    '<linearGradient id="xlink" xlink:href="#base"/>' +
    '<radialGradient id="cross" href="#base" cx="3"/>' +
    '<linearGradient id="self" href="#self"/>' +
    '<linearGradient id="loopA" href="#loopB"/>' +
    '<linearGradient id="loopB" href="#loopA"/>' +
    '<linearGradient id="dangling" href="#nope" x1="4"/>' +
    '</defs></svg>';

  it('inherits stops when the child declares none', () => {
    expect(grad(SVG, 'inherit').stops.map((s) => s.color))
      .toEqual([[1, 0, 0], [0, 0, 1]]);
  });

  it('keeps its own stops when it declares any', () => {
    expect(grad(SVG, 'own').stops.map((s) => s.color))
      .toEqual([[0, 1, 0], [0, 0, 0]]);
  });

  it('inherits attributes that are unset and keeps those that are set', () => {
    const g = grad(SVG, 'own');
    expect(g.attrs.get('x1')).toBe('9');
    expect(g.attrs.get('gradientUnits')).toBe('userSpaceOnUse');
    expect(g.attrs.get('spreadMethod')).toBe('reflect');
  });

  it('accepts the legacy xlink:href spelling', () => {
    // xml.ts strips the namespace prefix from attribute names, so this arrives
    // as a plain `href` — the test pins that end-to-end behaviour, not a
    // separate code path.
    expect(grad(SVG, 'xlink').stops).toHaveLength(2);
  });

  it('inherits across gradient types, keeping the child kind', () => {
    const g = grad(SVG, 'cross');
    expect(g.kind).toBe('radial');
    expect(g.stops).toHaveLength(2);
    expect(g.attrs.get('cx')).toBe('3');
    expect(g.attrs.get('spreadMethod')).toBe('reflect');
  });

  it('terminates on a self reference and on a two-node cycle', () => {
    expect(grad(SVG, 'self').stops).toEqual([]);
    expect(grad(SVG, 'loopA').stops).toEqual([]);
  });

  it('ignores an href that does not resolve', () => {
    const g = grad(SVG, 'dangling');
    expect(g.stops).toEqual([]);
    expect(g.attrs.get('x1')).toBe('4');
  });
});

describe('normalizeStops', () => {
  const s = (offset: number, color: [number, number, number]): GradientStop =>
    ({ offset, color, opacity: 1 });

  it('extends the ends to 0 and 1, repeating the adjacent colour', () => {
    expect(normalizeStops([s(0.25, [1, 0, 0]), s(0.75, [0, 0, 1])])).toEqual([
      s(0, [1, 0, 0]), s(0.25, [1, 0, 0]), s(0.75, [0, 0, 1]), s(1, [0, 0, 1]),
    ]);
  });

  it('leaves a list that already spans 0..1 alone', () => {
    const list = [s(0, [1, 0, 0]), s(1, [0, 0, 1])];
    expect(normalizeStops(list)).toEqual(list);
  });

  it('forces an out-of-order offset up to its predecessor', () => {
    expect(normalizeStops([s(0, [1, 0, 0]), s(0.8, [0, 1, 0]), s(0.2, [0, 0, 1]), s(1, [0, 0, 0])])
      .map((x) => x.offset)).toEqual([0, 0.8, 0.8, 1]);
  });

  it('preserves a doubled offset, which is the hard colour edge', () => {
    const out = normalizeStops([s(0, [1, 0, 0]), s(0.5, [1, 0, 0]), s(0.5, [0, 0, 1]), s(1, [0, 0, 1])]);
    expect(out.map((x) => x.offset)).toEqual([0, 0.5, 0.5, 1]);
    expect(out[1].color).toEqual([1, 0, 0]);
    expect(out[2].color).toEqual([0, 0, 1]);
  });

  it('passes an empty and a single-stop list through untouched', () => {
    expect(normalizeStops([])).toEqual([]);
    expect(normalizeStops([s(0.4, [1, 0, 0])])).toEqual([s(0.4, [1, 0, 0])]);
  });
});

describe('stopsFunction', () => {
  const s = (offset: number, color: [number, number, number]): GradientStop =>
    ({ offset, color, opacity: 1 });
  const fn = (list: GradientStop[]) => stopsFunction(normalizeStops(list));

  it('emits one type 2 exponential for two stops', () => {
    const f = fn([s(0, [1, 0, 0]), s(1, [0, 0, 1])]);
    expect(f.get('FunctionType')).toBe(2);
    expect(f.get('Domain')).toEqual([0, 1]);
    expect(f.get('C0')).toEqual([1, 0, 0]);
    expect(f.get('C1')).toEqual([0, 0, 1]);
    expect(f.get('N')).toBe(1);
  });

  it('stitches type 2s for three stops, with the interior offset as the bound', () => {
    const f = fn([s(0, [1, 0, 0]), s(0.25, [0, 1, 0]), s(1, [0, 0, 1])]);
    expect(f.get('FunctionType')).toBe(3);
    expect(f.get('Domain')).toEqual([0, 1]);
    expect(f.get('Bounds')).toEqual([0.25]);
    expect(f.get('Encode')).toEqual([0, 1, 0, 1]);
    const subs = f.get('Functions') as PdfDict[];
    expect(subs).toHaveLength(2);
    expect(subs[0].get('C0')).toEqual([1, 0, 0]);
    expect(subs[0].get('C1')).toEqual([0, 1, 0]);
    expect(subs[1].get('C0')).toEqual([0, 1, 0]);
    expect(subs[1].get('C1')).toEqual([0, 0, 1]);
  });

  it('drops the zero-width interval of a hard stop, keeping /Bounds strictly increasing', () => {
    const f = fn([s(0, [1, 0, 0]), s(0.5, [1, 0, 0]), s(0.5, [0, 0, 1]), s(1, [0, 0, 1])]);
    expect(f.get('FunctionType')).toBe(3);
    expect(f.get('Bounds')).toEqual([0.5]);
    const subs = f.get('Functions') as PdfDict[];
    expect(subs).toHaveLength(2);
    expect(subs[0].get('C1')).toEqual([1, 0, 0]);   // flat red up to 0.5
    expect(subs[1].get('C0')).toEqual([0, 0, 1]);   // flat blue after 0.5
  });

  it('keeps /Bounds strictly increasing across two adjacent hard stops', () => {
    const f = fn([
      s(0, [1, 0, 0]), s(0.3, [1, 0, 0]), s(0.3, [0, 1, 0]),
      s(0.6, [0, 1, 0]), s(0.6, [0, 0, 1]), s(1, [0, 0, 1]),
    ]);
    const bounds = f.get('Bounds') as number[];
    expect(bounds).toEqual([0.3, 0.6]);
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
    expect((f.get('Functions') as PdfDict[])).toHaveLength(3);
  });

  it('turns two stops at one offset into a flat-then-flat hard edge', () => {
    // normalizeStops pads to [red@0, red@.5, blue@.5, blue@1]; the two surviving
    // intervals are each a constant colour, so the whole thing is a step.
    const f = fn([s(0.5, [1, 0, 0]), s(0.5, [0, 0, 1])]);
    expect(f.get('FunctionType')).toBe(3);
    expect(f.get('Bounds')).toEqual([0.5]);
    const subs = f.get('Functions') as PdfDict[];
    expect(subs[0].get('C0')).toEqual([1, 0, 0]);
    expect(subs[0].get('C1')).toEqual([1, 0, 0]);
    expect(subs[1].get('C0')).toEqual([0, 0, 1]);
    expect(subs[1].get('C1')).toEqual([0, 0, 1]);
  });

  it('emits /Encode with one [0 1] pair per sub-function', () => {
    const f = fn([s(0, [1, 0, 0]), s(0.2, [0, 1, 0]), s(0.7, [0, 0, 1]), s(1, [0, 0, 0])]);
    expect(f.get('Encode')).toEqual([0, 1, 0, 1, 0, 1]);
    expect(f.get('Bounds')).toEqual([0.2, 0.7]);
  });

  const sa = (offset: number, opacity: number): GradientStop =>
    ({ offset, color: [0, 0, 0], opacity });

  it('projects a stop onto its alpha when asked for the ALPHA ramp', () => {
    const f = stopsFunction(normalizeStops([sa(0, 0), sa(1, 1)]), ALPHA);
    expect(f.get('FunctionType')).toBe(2);
    expect(f.get('C0')).toEqual([0]);
    expect(f.get('C1')).toEqual([1]);
  });

  it('gives the alpha ramp the same /Bounds and /Encode as the colour ramp', () => {
    // A hard stop at 0.5, so the shared "drop the zero-width interval" rule is
    // the thing under test: the two functions must stitch identically or the
    // mask will not line up with the colour it masks.
    const list = [
      { offset: 0, color: [1, 0, 0] as [number, number, number], opacity: 1 },
      { offset: 0.5, color: [1, 0, 0] as [number, number, number], opacity: 1 },
      { offset: 0.5, color: [0, 0, 1] as [number, number, number], opacity: 0.25 },
      { offset: 1, color: [0, 0, 1] as [number, number, number], opacity: 0 },
    ];
    const colour = stopsFunction(normalizeStops(list));
    const alpha = stopsFunction(normalizeStops(list), ALPHA);
    expect(alpha.get('FunctionType')).toBe(colour.get('FunctionType'));
    expect(alpha.get('Bounds')).toEqual(colour.get('Bounds'));
    expect(alpha.get('Encode')).toEqual(colour.get('Encode'));
    const subs = alpha.get('Functions') as PdfDict[];
    expect(subs[0].get('C0')).toEqual([1]);
    expect(subs[subs.length - 1].get('C1')).toEqual([0]);
  });
});

const VP: ViewBox = { minX: 0, minY: 0, w: 200, h: 100 };
/** A deliberately NON-SQUARE bbox: the only shape that distinguishes the two
 *  possible orderings of gradientTransform against the objectBoundingBox map. */
const BOX: SegBBox = { x: 10, y: 20, w: 40, h: 10 };

const paint = (svg: string, id: string, box: SegBBox | null = BOX,
               ctm: Matrix = [...IDENTITY]) => {
  const map = ids(svg);
  return gradientPaint(map.get(id)!, map, box, VP, ctm);
};
const shading = (p: ReturnType<typeof paint>) => {
  if (p.kind !== 'pattern') throw new Error(`expected a pattern, got ${p.kind}`);
  return p.pattern.get('Shading') as PdfDict;
};

const TWO = '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';

describe('gradientPaint — linear geometry', () => {
  it('builds a PatternType 2 pattern around a ShadingType 2', () => {
    const p = paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g');
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    expect(p.pattern.get('Type')).toMatchObject({ name: 'Pattern' });
    expect(p.pattern.get('PatternType')).toBe(2);
    const sh = shading(p);
    expect(sh.get('ShadingType')).toBe(2);
    expect(sh.get('ColorSpace')).toMatchObject({ name: 'DeviceRGB' });
    expect(sh.get('Extend')).toEqual([true, true]);
    expect((sh.get('Function') as PdfDict).get('FunctionType')).toBe(2);
  });

  it('applies the default axis x1=0% y1=0% x2=100% y2=0% in bbox units', () => {
    const p = paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g');
    expect(shading(p).get('Coords')).toEqual([0, 0, 1, 0]);
  });

  it('maps objectBoundingBox onto the shape box in the /Matrix', () => {
    const p = paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g');
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    expect(p.pattern.get('Matrix')).toEqual([40, 0, 0, 10, 10, 20]);
  });

  it('takes userSpaceOnUse coordinates verbatim and leaves the bbox out of /Matrix', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `x1="5" y1="6" x2="7" y2="8">${TWO}</linearGradient></svg>`, 'g');
    expect(shading(p).get('Coords')).toEqual([5, 6, 7, 8]);
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    expect(p.pattern.get('Matrix')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('resolves userSpaceOnUse percentages against the viewport', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `x1="50%" y1="50%" x2="100%" y2="0%">${TWO}</linearGradient></svg>`, 'g');
    expect(shading(p).get('Coords')).toEqual([100, 50, 200, 0]);
  });

  it('composes gradientTransform INSIDE the bbox map, not outside it', () => {
    // rotate(90) about the gradient-space origin. Inside the obb map (correct) the
    // rotation happens in the unit square and is then stretched 40x10; outside it,
    // the whole 40x10 box would rotate about the element origin. The non-square
    // bbox is what separates them.
    const p = paint('<svg><linearGradient id="g" gradientTransform="rotate(90)">' +
      `${TWO}</linearGradient></svg>`, 'g');
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    const m = p.pattern.get('Matrix') as number[];
    // mul(rotate90, [40 0 0 10 10 20]) = [0, 10, -40, 0, 10, 20]
    m.forEach((v, i) => expect(v).toBeCloseTo([0, 10, -40, 0, 10, 20][i], 9));
  });

  it('bakes the element CTM into /Matrix as the outermost factor', () => {
    const p = paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g',
      BOX, [2, 0, 0, 2, 5, 5]);
    if (p.kind !== 'pattern') throw new Error('expected a pattern');
    // mul([40 0 0 10 10 20], [2 0 0 2 5 5]) = [80 0 0 20 25 45]
    expect(p.pattern.get('Matrix')).toEqual([80, 0, 0, 20, 25, 45]);
  });
});

describe('gradientPaint — radial geometry', () => {
  it('applies the defaults cx=cy=r=50% with the focus at the centre', () => {
    const p = paint(`<svg><radialGradient id="g">${TWO}</radialGradient></svg>`, 'g');
    const sh = shading(p);
    expect(sh.get('ShadingType')).toBe(3);
    expect(sh.get('Coords')).toEqual([0.5, 0.5, 0, 0.5, 0.5, 0.5]);
    expect(sh.get('Extend')).toEqual([true, true]);
  });

  it('puts fx/fy in the inner circle of radius 0', () => {
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="50" cy="50" r="20" fx="55" fy="45">${TWO}</radialGradient></svg>`, 'g');
    expect(shading(p).get('Coords')).toEqual([55, 45, 0, 50, 50, 20]);
  });

  it('pulls a focal point outside the circle back onto it (SVG 1.1)', () => {
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="0" cy="0" r="10" fx="100" fy="0">${TWO}</radialGradient></svg>`, 'g');
    const c = shading(p).get('Coords') as number[];
    expect(c[0]).toBeCloseTo(9.99, 6);   // 10 * 0.999, along +x
    expect(c[1]).toBeCloseTo(0, 9);
  });

  it('resolves a percentage r against the normalized diagonal', () => {
    // sqrt((200^2 + 100^2) / 2) = sqrt(25000) ~ 158.1139
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `r="50%">${TWO}</radialGradient></svg>`, 'g');
    const c = shading(p).get('Coords') as number[];
    expect(c[5]).toBeCloseTo(Math.sqrt((200 * 200 + 100 * 100) / 2) / 2, 6);
  });
});

describe('gradientPaint — degenerate cases (all SVG-mandated, none reported)', () => {
  it('paints nothing when the gradient has no stops', () => {
    const p = paint('<svg><linearGradient id="g"/></svg>', 'g');
    expect(p.kind).toBe('none');
    expect(p.report).toBe(false);
  });

  it('paints a solid colour for exactly one stop', () => {
    const p = paint('<svg><linearGradient id="g"><stop offset="0.3" stop-color="lime"/>' +
      '</linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 1, 0], opacity: 1, report: false });
  });

  it('paints the LAST stop solid when a linear axis has zero length', () => {
    const p = paint('<svg><linearGradient id="g" x1="0.4" y1="0.4" x2="0.4" y2="0.4">' +
      `${TWO}</linearGradient></svg>`, 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 0, 1] });
  });

  it('paints the LAST stop solid when a radial radius is zero', () => {
    const p = paint(`<svg><radialGradient id="g" r="0">${TWO}</radialGradient></svg>`, 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 0, 1] });
  });

  it('takes the LAST stop alpha when a linear axis has zero length', () => {
    const p = paint('<svg><linearGradient id="g" x1="0.4" y1="0.4" x2="0.4" y2="0.4">' +
      '<stop offset="0" stop-color="red" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.25"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 0, 1], opacity: 0.25, report: false });
  });

  it('takes the LAST stop alpha when a radial radius is zero', () => {
    const p = paint('<svg><radialGradient id="g" r="0">' +
      '<stop offset="0" stop-color="red" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.25"/></radialGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'solid', color: [0, 0, 1], opacity: 0.25, report: false });
  });

  it('suppresses the paint when objectBoundingBox meets a zero-area box', () => {
    expect(paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g',
      { x: 5, y: 5, w: 0, h: 30 }).kind).toBe('none');
    expect(paint(`<svg><linearGradient id="g">${TWO}</linearGradient></svg>`, 'g', null)
      .kind).toBe('none');
  });

  it('still paints a userSpaceOnUse gradient on a zero-area box', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `x1="0" x2="10">${TWO}</linearGradient></svg>`, 'g', { x: 5, y: 5, w: 0, h: 30 });
    expect(p.kind).toBe('pattern');
  });
});

describe('gradientPaint — opacity', () => {
  it('folds a uniform stop-opacity into the paint opacity', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.4"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.4"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'pattern', opacity: 0.4, report: false });
  });

  it('builds a grayscale alpha twin, unreported, when stop-opacity varies', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.2"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'pattern', opacity: 1, report: false });
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    const sh = p.alphaPattern.get('Shading') as PdfDict;
    expect(sh.get('ColorSpace')).toMatchObject({ name: 'DeviceGray' });
    expect(sh.get('ShadingType')).toBe(2);
    expect(sh.get('Coords')).toEqual(shading(p).get('Coords'));
    const f = sh.get('Function') as PdfDict;
    expect(f.get('C0')).toEqual([1]);
    expect(f.get('C1')).toEqual([0.2]);
  });

  it('leaves the alpha twin null when every stop shares one alpha', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.4"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.4"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'pattern', alphaPattern: null });
  });

  it('omits the element CTM from the alpha twin /Matrix but keeps it on the colour', () => {
    // The mask group's space IS element user space, so the CTM must cancel.
    const ctm: Matrix = [2, 0, 0, 3, 7, 11];
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="1"/></linearGradient></svg>',
      'g', { x: 5, y: 6, w: 10, h: 20 }, ctm);
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    expect(p.alphaPattern.get('Matrix')).toEqual([10, 0, 0, 20, 5, 6]);
    expect(p.pattern.get('Matrix')).toEqual([20, 0, 0, 60, 17, 29]);
  });

  it('builds an alpha twin for a radial gradient too', () => {
    const p = paint('<svg><radialGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="1"/></radialGradient></svg>', 'g');
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    const sh = p.alphaPattern.get('Shading') as PdfDict;
    expect(sh.get('ShadingType')).toBe(3);
    expect(sh.get('Coords')).toEqual(shading(p).get('Coords'));
  });

  it('tiles the alpha ramp with the colour ramp under a repeat spread', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      'spreadMethod="repeat" x1="0" y1="0" x2="10" y2="0">' +
      '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="1"/></linearGradient></svg>',
      'g', { x: 0, y: 0, w: 30, h: 10 });
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    const a = (p.alphaPattern.get('Shading') as PdfDict).get('Function') as PdfDict;
    const c = (shading(p).get('Function')) as PdfDict;
    expect(a.get('Bounds')).toEqual(c.get('Bounds'));
    expect((a.get('Functions') as PdfDict[]).length)
      .toBe((c.get('Functions') as PdfDict[]).length);
  });

  it('carries a uniform stop-opacity onto a solid degenerate result too', () => {
    const p = paint('<svg><linearGradient id="g">' +
      '<stop offset="0.3" stop-color="lime" stop-opacity="0.5"/></linearGradient></svg>', 'g');
    expect(p).toMatchObject({ kind: 'solid', opacity: 0.5 });
  });
});

describe('spreadRange', () => {
  const M: Matrix = [...IDENTITY];

  it('covers exactly [0, 1] when the box matches the axis', () => {
    expect(spreadRange([0, 0], [1, 0], M, { x: 0, y: 0, w: 1, h: 1 })).toEqual([0, 1]);
  });

  it('floors and ceils the projected t interval', () => {
    // axis 0..10 in x; box spans x -5..25 -> t in [-0.5, 2.5] -> [-1, 3]
    expect(spreadRange([0, 0], [10, 0], M, { x: -5, y: 0, w: 30, h: 4 })).toEqual([-1, 3]);
  });

  it('never returns an empty range', () => {
    const r = spreadRange([0, 0], [10, 0], M, { x: 2, y: 0, w: 1, h: 1 })!;
    expect(r[1]).toBeGreaterThan(r[0]);
  });

  it('projects through the inverse of the matrix', () => {
    // The obb map [10 0 0 10 0 0] puts the unit box at 0..10; a 0..1 axis in
    // gradient space then covers it exactly once.
    expect(spreadRange([0, 0], [1, 0], [10, 0, 0, 10, 0, 0], { x: 0, y: 0, w: 10, h: 10 }))
      .toEqual([0, 1]);
  });

  it('returns null past the repetition cap and for a singular matrix', () => {
    expect(spreadRange([0, 0], [1, 0], M, { x: 0, y: 0, w: 1000, h: 1 }, 64)).toBeNull();
    expect(spreadRange([0, 0], [1, 0], [0, 0, 0, 0, 0, 0], { x: 0, y: 0, w: 1, h: 1 }))
      .toBeNull();
    expect(spreadRange([0, 0], [1, 0], M, null)).toBeNull();
  });
});

describe('radialSpreadRange', () => {
  const M: Matrix = [...IDENTITY];

  /** Does the circle at parameter `k` contain every corner of `b`?
   *
   *  Plain distance arithmetic, deliberately NOT the quadratic the function
   *  under test solves: a differential test cannot validate the interpreter it
   *  runs through. This checks the PROPERTY k must have. */
  const coversAt = (
    k: number, f: [number, number], c: [number, number], r: number, b: SegBBox,
  ): boolean => {
    const cx = f[0] + k * (c[0] - f[0]);
    const cy = f[1] + k * (c[1] - f[1]);
    const R = k * r;
    return ([
      [b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
    ] as [number, number][]).every(([px, py]) => Math.hypot(px - cx, py - cy) <= R + 1e-9);
  };

  it('matches ceil(L / r) when the focus is centred', () => {
    // Corners of a 30x40 box from the origin: the far one is at 50.
    expect(radialSpreadRange([0, 0], [0, 0], 10, M, { x: 0, y: 0, w: 30, h: 40 })).toBe(5);
  });

  it('returns the tightest covering k with an eccentric focus', () => {
    const f: [number, number] = [2, 0];
    const c: [number, number] = [0, 0];
    const b: SegBBox = { x: 0, y: 0, w: 30, h: 40 };
    const k = radialSpreadRange(f, c, 10, M, b)!;
    expect(k).not.toBeNull();
    expect(coversAt(k, f, c, 10, b)).toBe(true);
    // Tightness: without this, a function that always returned the cap passes.
    expect(coversAt(k - 1, f, c, 10, b)).toBe(false);
  });

  it('never returns zero, even for a box at the focal point', () => {
    expect(radialSpreadRange([0, 0], [0, 0], 10, M, { x: 0, y: 0, w: 0, h: 0 })).toBe(1);
  });

  it('projects through the inverse of the matrix', () => {
    // The obb map [10 0 0 10 0 0] puts a 0..10 box back on the unit square, whose
    // corners sit sqrt(0.5) = 0.7071 from the centre; over r = 0.5 that is 1.414.
    expect(radialSpreadRange([0.5, 0.5], [0.5, 0.5], 0.5, [10, 0, 0, 10, 0, 0],
      { x: 0, y: 0, w: 10, h: 10 })).toBe(2);
  });

  it('returns null past the cap, for a singular matrix, and with no box', () => {
    expect(radialSpreadRange([0, 0], [0, 0], 1, M, { x: 0, y: 0, w: 1000, h: 1000 }, 64))
      .toBeNull();
    expect(radialSpreadRange([0, 0], [0, 0], 1, [0, 0, 0, 0, 0, 0], { x: 0, y: 0, w: 1, h: 1 }))
      .toBeNull();
    expect(radialSpreadRange([0, 0], [0, 0], 1, M, null)).toBeNull();
  });

  it('returns null when the focus is not strictly inside the circle', () => {
    // gradientPaint's 0.999 clamp prevents this, but the guard keeps the
    // function total: with |d| >= r the quadratic's leading term is not negative
    // and the root analysis does not hold.
    expect(radialSpreadRange([20, 0], [0, 0], 10, M, { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});

describe('tileStops', () => {
  const base = normalizeStops([
    { offset: 0, color: [1, 0, 0] as [number, number, number], opacity: 1 },
    { offset: 1, color: [0, 0, 1] as [number, number, number], opacity: 1 },
  ]);

  it('packs n forward copies for repeat', () => {
    const out = tileStops(base, 0, 2, false);
    expect(out.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
    expect(out.map((s) => s.color)).toEqual([[1, 0, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1]]);
  });

  it('mirrors the odd copies for reflect', () => {
    const out = tileStops(base, 0, 2, true);
    expect(out.map((s) => s.color)).toEqual([[1, 0, 0], [0, 0, 1], [0, 0, 1], [1, 0, 0]]);
  });

  it('uses k0 parity, so a range starting at an odd integer starts mirrored', () => {
    const out = tileStops(base, 1, 2, true);
    expect(out.map((s) => s.color)).toEqual([[0, 0, 1], [1, 0, 0], [1, 0, 0], [0, 0, 1]]);
  });

  it('handles a negative k0 parity without a negative modulo', () => {
    const out = tileStops(base, -1, 1, true);
    expect(out.map((s) => s.color)).toEqual([[0, 0, 1], [1, 0, 0]]);
  });

  it('returns the list unchanged for a single forward copy', () => {
    expect(tileStops(base, 0, 1, false)).toEqual(base);
  });
});

describe('gradientPaint — spreadMethod', () => {
  it('extends the coords over the repetition range for repeat', () => {
    // userSpaceOnUse axis 0..10, box x 0..40 -> t in [0, 4] -> coords 0..40
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="repeat" x1="0" x2="10">${TWO}</linearGradient></svg>`, 'g',
      { x: 0, y: 0, w: 40, h: 10 });
    const sh = shading(p);
    expect(sh.get('Coords')).toEqual([0, 0, 40, 0]);
    expect((sh.get('Function') as PdfDict).get('Bounds')).toEqual([0.25, 0.5, 0.75]);
    expect(sh.get('Extend')).toEqual([true, true]);
  });

  it('mirrors alternate copies for reflect', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="reflect" x1="0" x2="10">${TWO}</linearGradient></svg>`, 'g',
      { x: 0, y: 0, w: 20, h: 10 });
    const subs = ((shading(p).get('Function')) as PdfDict).get('Functions') as PdfDict[];
    expect(subs).toHaveLength(2);
    expect(subs[0].get('C0')).toEqual([1, 0, 0]);
    expect(subs[0].get('C1')).toEqual([0, 0, 1]);
    expect(subs[1].get('C0')).toEqual([0, 0, 1]);   // mirrored
    expect(subs[1].get('C1')).toEqual([1, 0, 0]);
  });

  it('degrades to pad past the 64-repetition cap, without reporting', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="repeat" x1="0" x2="1">${TWO}</linearGradient></svg>`, 'g',
      { x: 0, y: 0, w: 1000, h: 10 });
    const sh = shading(p);
    expect(sh.get('Coords')).toEqual([0, 0, 1, 0]);
    expect(p.report).toBe(false);
  });

  it('leaves pad alone', () => {
    const p = paint('<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="pad" x1="0" x2="10">${TWO}</linearGradient></svg>`, 'g',
      { x: 0, y: 0, w: 40, h: 10 });
    expect(shading(p).get('Coords')).toEqual([0, 0, 10, 0]);
  });

  it('extends the radial coords over the repetition range for repeat', () => {
    // Default obb radial: f = c = (0.5, 0.5), r = 0.5. The unit box's corners sit
    // at sqrt(0.5) = 0.7071, so t = 1.414 and k = 2 — outer radius 2 * 0.5 = 1.
    const p = paint(`<svg><radialGradient id="g" spreadMethod="repeat">${TWO}` +
      '</radialGradient></svg>', 'g');
    expect(p.report).toBe(false);
    const sh = shading(p);
    expect(sh.get('Coords')).toEqual([0.5, 0.5, 0, 0.5, 0.5, 1]);
    expect((sh.get('Function') as PdfDict).get('Bounds')).toEqual([0.5]);
    expect(sh.get('Extend')).toEqual([true, true]);
  });

  it('mirrors alternate radial copies for reflect', () => {
    const p = paint(`<svg><radialGradient id="g" spreadMethod="reflect">${TWO}` +
      '</radialGradient></svg>', 'g');
    const subs = ((shading(p).get('Function')) as PdfDict).get('Functions') as PdfDict[];
    expect(subs).toHaveLength(2);
    expect(subs[0].get('C0')).toEqual([1, 0, 0]);
    expect(subs[0].get('C1')).toEqual([0, 0, 1]);
    expect(subs[1].get('C0')).toEqual([0, 0, 1]);   // mirrored
    expect(subs[1].get('C1')).toEqual([1, 0, 0]);
  });

  it('scales an eccentric focal radial about the focus, not the centre', () => {
    // f = (2,0), c = (0,0), r = 10 over a 30x40 box gives k = 6: the inner circle
    // stays the focus at radius 0 and the outer moves to f + 6d = (-10, 0), r 60.
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="0" cy="0" r="10" fx="2" fy="0" spreadMethod="repeat">${TWO}` +
      '</radialGradient></svg>', 'g', { x: 0, y: 0, w: 30, h: 40 });
    expect(shading(p).get('Coords')).toEqual([2, 0, 0, -10, 0, 60]);
  });

  it('leaves a radial pad alone', () => {
    const p = paint(`<svg><radialGradient id="g" spreadMethod="pad">${TWO}` +
      '</radialGradient></svg>', 'g');
    expect(shading(p).get('Coords')).toEqual([0.5, 0.5, 0, 0.5, 0.5, 0.5]);
  });

  it('degrades a radial repeat to pad past the cap, without reporting', () => {
    const p = paint('<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="0" cy="0" r="1" spreadMethod="repeat">${TWO}</radialGradient></svg>`,
      'g', { x: 0, y: 0, w: 1000, h: 1000 });
    expect(shading(p).get('Coords')).toEqual([0, 0, 0, 0, 0, 1]);
    expect(p.report).toBe(false);
  });

  it('gives the alpha twin the same tiled radial coords and function', () => {
    const p = paint('<svg><radialGradient id="g" spreadMethod="repeat">' +
      '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="1"/></radialGradient></svg>', 'g');
    if (p.kind !== 'pattern' || p.alphaPattern === null) throw new Error('expected an alpha twin');
    const a = p.alphaPattern.get('Shading') as PdfDict;
    expect(a.get('Coords')).toEqual(shading(p).get('Coords'));
    expect((a.get('Function') as PdfDict).get('Bounds'))
      .toEqual((shading(p).get('Function') as PdfDict).get('Bounds'));
  });

  it('cancels the element CTM out of the radial range computation', () => {
    const svg = '<svg><radialGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `cx="0" cy="0" r="10" spreadMethod="repeat">${TWO}</radialGradient></svg>`;
    const box = { x: 0, y: 0, w: 30, h: 40 };
    const a = shading(paint(svg, 'g', box));
    const b = shading(paint(svg, 'g', box, [3, 0, 0, 3, 7, 7]));
    expect(b.get('Coords')).toEqual(a.get('Coords'));
  });

  it('cancels the element CTM out of the range computation', () => {
    // The same gradient and the same shape under a 3x CTM must produce the same
    // repetition count — the shape is in element space and the pattern /Matrix
    // carries the same CTM factor, so it cancels.
    const svg = '<svg><linearGradient id="g" gradientUnits="userSpaceOnUse" ' +
      `spreadMethod="repeat" x1="0" x2="10">${TWO}</linearGradient></svg>`;
    const box = { x: 0, y: 0, w: 40, h: 10 };
    const a = shading(paint(svg, 'g', box));
    const b = shading(paint(svg, 'g', box, [3, 0, 0, 3, 7, 7]));
    expect(b.get('Coords')).toEqual(a.get('Coords'));
  });
});
