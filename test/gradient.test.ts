import { describe, it, expect } from 'vitest';
import {
  normalizeStops, stopsFunction, validateGradient, axialShading, radialShading,
  shadingPattern, ALPHA, uniformOpacity,
  type GradientStop, type LinearGradient, type RadialGradient, type Gradient,
} from '../src/gradient.js';
import { isDict, isName, type PdfDict } from '../src/types.js';

const RED: [number, number, number] = [1, 0, 0];
const BLUE: [number, number, number] = [0, 0, 1];
const GREEN: [number, number, number] = [0, 1, 0];

const linear = (stops: GradientStop[], over: Partial<LinearGradient> = {}): LinearGradient =>
  ({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops, ...over });

const radial = (stops: GradientStop[], over: Partial<RadialGradient> = {}): RadialGradient =>
  ({ kind: 'radial', cx: 50, cy: 50, r: 25, stops, ...over });

/** A dict entry, typed loosely for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const at = (d: PdfDict, k: string): any => d.get(k);

/** A /Name's text, or undefined when the entry is not a name. */
const nameOf = (d: PdfDict, k: string): string | undefined => {
  const v = d.get(k);
  return isName(v) ? v.name : undefined;
};

describe('normalizeStops', () => {
  it('pads the list out to 0 and 1 by repeating the adjacent colour', () => {
    const out = normalizeStops([
      { offset: 0.25, color: RED }, { offset: 0.75, color: BLUE },
    ]);
    expect(out.map((s) => s.offset)).toEqual([0, 0.25, 0.75, 1]);
    expect(out[0].color).toEqual(RED);
    expect(out[3].color).toEqual(BLUE);
  });

  it('forces offsets non-decreasing', () => {
    const out = normalizeStops([
      { offset: 0, color: RED }, { offset: 0.8, color: GREEN }, { offset: 0.3, color: BLUE },
    ]);
    expect(out.map((s) => s.offset)).toEqual([0, 0.8, 0.8, 1]);
  });

  it('keeps a doubled offset, which is the hard colour edge', () => {
    const out = normalizeStops([
      { offset: 0, color: RED }, { offset: 0.5, color: RED },
      { offset: 0.5, color: BLUE }, { offset: 1, color: BLUE },
    ]);
    expect(out.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
  });

  it('leaves a list of fewer than two stops alone, but copies it', () => {
    const input = [{ offset: 0.5, color: RED }];
    const out = normalizeStops(input);
    expect(out).toEqual(input);
    expect(out[0]).not.toBe(input[0]);
  });
});

describe('stopsFunction', () => {
  it('emits a bare type 2 for a single interval', () => {
    const fn = stopsFunction([{ offset: 0, color: RED }, { offset: 1, color: BLUE }]);
    expect(at(fn, 'FunctionType')).toBe(2);
    expect(at(fn, 'Domain')).toEqual([0, 1]);
    expect(at(fn, 'C0')).toEqual(RED);
    expect(at(fn, 'C1')).toEqual(BLUE);
    expect(at(fn, 'N')).toBe(1);
  });

  it('stitches multiple intervals into a type 3 with strictly increasing bounds', () => {
    const fn = stopsFunction([
      { offset: 0, color: RED }, { offset: 0.4, color: GREEN }, { offset: 1, color: BLUE },
    ]);
    expect(at(fn, 'FunctionType')).toBe(3);
    expect(at(fn, 'Bounds')).toEqual([0.4]);
    expect(at(fn, 'Encode')).toEqual([0, 1, 0, 1]);
    expect(at(fn, 'Functions')).toHaveLength(2);
    const bounds: number[] = at(fn, 'Bounds');
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
  });

  it('contributes no sub-function for a zero-width interval', () => {
    // Four stops, three intervals, but the middle one has zero width.
    const fn = stopsFunction([
      { offset: 0, color: RED }, { offset: 0.5, color: RED },
      { offset: 0.5, color: BLUE }, { offset: 1, color: BLUE },
    ]);
    expect(at(fn, 'FunctionType')).toBe(3);
    expect(at(fn, 'Functions')).toHaveLength(2);   // not 3
    expect(at(fn, 'Bounds')).toEqual([0.5]);
  });

  it('gives the ALPHA twin identical Bounds and Encode', () => {
    const stops: GradientStop[] = [
      { offset: 0, color: RED, opacity: 0.2 },
      { offset: 0.4, color: GREEN, opacity: 0.6 },
      { offset: 1, color: BLUE, opacity: 1 },
    ];
    const rgb = stopsFunction(stops);
    const gray = stopsFunction(stops, ALPHA);
    expect(at(gray, 'Bounds')).toEqual(at(rgb, 'Bounds'));
    expect(at(gray, 'Encode')).toEqual(at(rgb, 'Encode'));
    const first: PdfDict = at(gray, 'Functions')[0];
    expect(at(first, 'C0')).toEqual([0.2]);        // one DeviceGray component
    expect(at(first, 'C1')).toEqual([0.6]);
  });

  it('defaults a stop with no opacity to fully opaque in the ALPHA twin', () => {
    const fn = stopsFunction([{ offset: 0, color: RED }, { offset: 1, color: BLUE }], ALPHA);
    expect(at(fn, 'C0')).toEqual([1]);
    expect(at(fn, 'C1')).toEqual([1]);
  });
});

describe('uniformOpacity', () => {
  it('reports the shared alpha, treating an absent opacity as 1', () => {
    expect(uniformOpacity([{ offset: 0, color: RED }, { offset: 1, color: BLUE }])).toBe(1);
    expect(uniformOpacity([
      { offset: 0, color: RED, opacity: 0.5 }, { offset: 1, color: BLUE, opacity: 0.5 },
    ])).toBe(0.5);
  });

  it('returns null when the stops disagree', () => {
    expect(uniformOpacity([
      { offset: 0, color: RED, opacity: 0.5 }, { offset: 1, color: BLUE },
    ])).toBeNull();
  });
});

describe('validateGradient', () => {
  const ok: GradientStop[] = [{ offset: 0, color: RED }, { offset: 1, color: BLUE }];

  it('accepts a well-formed linear gradient', () => {
    expect(() => validateGradient(linear(ok))).not.toThrow();
    expect(() => validateGradient(linear(ok, { extend: [false, true] }))).not.toThrow();
  });

  it('accepts a well-formed radial gradient', () => {
    expect(() => validateGradient({
      kind: 'radial', cx: 50, cy: 50, r: 25, stops: ok,
    })).not.toThrow();
    expect(() => validateGradient({
      kind: 'radial', cx: 50, cy: 50, r: 25, fx: 40, fy: 60, stops: ok,
    })).not.toThrow();
  });

  it('rejects an empty stop list', () => {
    expect(() => validateGradient(linear([]))).toThrow(TypeError);
  });

  it('rejects a non-array stop list', () => {
    expect(() => validateGradient(linear(undefined as unknown as GradientStop[])))
      .toThrow(TypeError);
  });

  it('rejects an unknown kind', () => {
    expect(() => validateGradient({ kind: 'conic', stops: ok } as unknown as Gradient))
      .toThrow(TypeError);
  });

  it('rejects a non-finite offset', () => {
    expect(() => validateGradient(linear([{ offset: NaN, color: RED }, { offset: 1, color: BLUE }])))
      .toThrow(TypeError);
  });

  it('rejects a malformed colour', () => {
    expect(() => validateGradient(linear([{ offset: 0, color: [1, 0] as never }, ...ok])))
      .toThrow(TypeError);
    expect(() => validateGradient(linear([{ offset: 0, color: [1, 0, 2] }, ...ok])))
      .toThrow(TypeError);
  });

  it('rejects an out-of-range opacity', () => {
    expect(() => validateGradient(linear([{ offset: 0, color: RED, opacity: 1.5 }, ...ok])))
      .toThrow(TypeError);
  });

  it('rejects non-finite geometry', () => {
    expect(() => validateGradient(linear(ok, { x2: Infinity }))).toThrow(TypeError);
    expect(() => validateGradient({ kind: 'radial', cx: 0, cy: 0, r: NaN, stops: ok }))
      .toThrow(TypeError);
  });

  it('rejects a negative radius', () => {
    expect(() => validateGradient({ kind: 'radial', cx: 0, cy: 0, r: -1, stops: ok }))
      .toThrow(TypeError);
  });

  it('rejects a malformed extend', () => {
    expect(() => validateGradient(linear(ok, { extend: [true] as never }))).toThrow(TypeError);
    expect(() => validateGradient(linear(ok, { extend: [1, 0] as never }))).toThrow(TypeError);
  });
});

describe('axialShading', () => {
  it('builds a DeviceRGB ShadingType 2 over the gradient axis', () => {
    const g = linear([{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
                     { x1: 10, y1: 20, x2: 110, y2: 20 });
    const sh = axialShading(g, normalizeStops(g.stops));
    expect(at(sh, 'ShadingType')).toBe(2);
    expect(nameOf(sh, 'ColorSpace')).toBe('DeviceRGB');
    expect(at(sh, 'Coords')).toEqual([10, 20, 110, 20]);
    expect(at(sh, 'Extend')).toEqual([true, true]);
    expect(isDict(at(sh, 'Function'))).toBe(true);
  });

  it('honours an explicit extend', () => {
    const g = linear([{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
                     { extend: [false, false] });
    expect(at(axialShading(g, normalizeStops(g.stops)), 'Extend')).toEqual([false, false]);
  });
});

describe('radialShading', () => {
  const ramp = (): GradientStop[] => [{ offset: 0, color: RED }, { offset: 1, color: BLUE }];

  it('builds a DeviceRGB ShadingType 3 from a zero-radius focus circle to the rim', () => {
    const g = radial(ramp(), { cx: 60, cy: 70, r: 30 });
    const sh = radialShading(g, normalizeStops(g.stops));
    expect(at(sh, 'ShadingType')).toBe(3);
    expect(nameOf(sh, 'ColorSpace')).toBe('DeviceRGB');
    // The inner circle is the focus at radius 0; the outer is the gradient circle.
    expect(at(sh, 'Coords')).toEqual([60, 70, 0, 60, 70, 30]);
    expect(at(sh, 'Extend')).toEqual([true, true]);
    expect(isDict(at(sh, 'Function'))).toBe(true);
  });

  it('places the inner circle at an explicit focal point', () => {
    const g = radial(ramp(), { cx: 50, cy: 50, r: 25, fx: 40, fy: 60 });
    expect(at(radialShading(g, normalizeStops(g.stops)), 'Coords'))
      .toEqual([40, 60, 0, 50, 50, 25]);
  });

  it('takes the centre for whichever focal coordinate is omitted', () => {
    const g = radial(ramp(), { cx: 50, cy: 50, r: 25, fx: 40 });
    expect(at(radialShading(g, normalizeStops(g.stops)), 'Coords'))
      .toEqual([40, 50, 0, 50, 50, 25]);
  });

  it('pulls a focus outside the circle back to just inside it', () => {
    // (100, 50) is 50 out from a radius-25 circle. PDF's cone is degenerate when
    // the focus lands exactly ON the rim, so the clamp stops fractionally short.
    const g = radial(ramp(), { cx: 50, cy: 50, r: 25, fx: 100, fy: 50 });
    const [fx, fy, r0, cx, cy, r1] = at(radialShading(g, normalizeStops(g.stops)), 'Coords');
    expect(Math.hypot(fx - cx, fy - cy)).toBeLessThan(25);
    expect(Math.hypot(fx - cx, fy - cy)).toBeGreaterThan(24.9);
    expect(fy).toBeCloseTo(50, 9);       // clamped along the line to the centre
    expect([r0, cx, cy, r1]).toEqual([0, 50, 50, 25]);
  });

  it('leaves a focus exactly on the rim inside the circle', () => {
    const g = radial(ramp(), { cx: 50, cy: 50, r: 25, fx: 75, fy: 50 });
    const [fx, , , cx, cy] = at(radialShading(g, normalizeStops(g.stops)), 'Coords');
    expect(Math.hypot(fx - cx, 50 - cy)).toBeLessThan(25);
  });

  it('honours an explicit extend', () => {
    const g = radial(ramp(), { extend: [false, false] });
    expect(at(radialShading(g, normalizeStops(g.stops)), 'Extend')).toEqual([false, false]);
  });
});

describe("a shading's alpha twin", () => {
  // Alphas that DIFFER: the case a uniform /ca cannot express.
  const varying = (): GradientStop[] => [
    { offset: 0, color: RED, opacity: 1 },
    { offset: 0.5, color: GREEN, opacity: 0.25 },
    { offset: 1, color: BLUE, opacity: 0 },
  ];

  it('matches the colour shading everywhere except colour space and function', () => {
    const g = linear(varying(), { x1: 10, y1: 20, x2: 110, y2: 20, extend: [false, true] });
    const stops = normalizeStops(g.stops);
    const colour = axialShading(g, stops);
    const alpha = axialShading(g, stops, 'alpha');

    expect(at(alpha, 'ShadingType')).toBe(at(colour, 'ShadingType'));
    expect(nameOf(alpha, 'ColorSpace')).toBe('DeviceGray');
    // Geometry identical: a mask that does not line up with what it masks is
    // worse than no mask at all.
    expect(at(alpha, 'Coords')).toEqual(at(colour, 'Coords'));
    expect(at(alpha, 'Extend')).toEqual(at(colour, 'Extend'));
  });

  it('stitches at the same bounds, one gray component carrying each stop alpha', () => {
    const g = linear(varying());
    const stops = normalizeStops(g.stops);
    const fn = at(axialShading(g, stops, 'alpha'), 'Function') as PdfDict;
    const colourFn = at(axialShading(g, stops), 'Function') as PdfDict;

    expect(at(fn, 'FunctionType')).toBe(3);
    expect(at(fn, 'Bounds')).toEqual(at(colourFn, 'Bounds'));
    expect(at(fn, 'Encode')).toEqual(at(colourFn, 'Encode'));

    const subs = at(fn, 'Functions') as PdfDict[];
    expect(subs.map((s) => at(s, 'C0'))).toEqual([[1], [0.25]]);
    expect(subs.map((s) => at(s, 'C1'))).toEqual([[0.25], [0]]);
  });

  it('is the same twin for a radial shading', () => {
    const g = radial(varying(), { cx: 60, cy: 70, r: 30, fx: 50 });
    const stops = normalizeStops(g.stops);
    const alpha = radialShading(g, stops, 'alpha');
    expect(at(alpha, 'ShadingType')).toBe(3);
    expect(nameOf(alpha, 'ColorSpace')).toBe('DeviceGray');
    expect(at(alpha, 'Coords')).toEqual(at(radialShading(g, stops), 'Coords'));
  });

  it("defaults to the colour twin, so a caller that forgets the variant cannot mask", () => {
    const g = linear(varying());
    expect(nameOf(axialShading(g, normalizeStops(g.stops)), 'ColorSpace')).toBe('DeviceRGB');
    expect(nameOf(radialShading(radial(varying()), normalizeStops(g.stops)), 'ColorSpace'))
      .toBe('DeviceRGB');
  });
});

describe('shadingPattern', () => {
  it('wraps a shading in a PatternType 2 with no /Matrix', () => {
    const g = linear([{ offset: 0, color: RED }, { offset: 1, color: BLUE }]);
    const p = shadingPattern(axialShading(g, normalizeStops(g.stops)));
    expect(nameOf(p, 'Type')).toBe('Pattern');
    expect(at(p, 'PatternType')).toBe(2);
    expect(isDict(at(p, 'Shading'))).toBe(true);
    // Identity is the default; an explicit /Matrix here would be a bug, since
    // gradient coords are already in the parent stream's default space.
    expect(p.has('Matrix')).toBe(false);
  });
});
