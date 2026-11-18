import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';

describe('PostScript current paths', () => {
  it('retains collinear cubic excursions when flattening', () => {
    const { vm } = runGraphics('0 0 moveto 100 0 100 0 1 0 curveto flattenpath pathbbox');
    expect(vm.stack).toMatchObject([{ value: 0 }, { value: 0 }, { kind: 'real' }, { value: 0 }]);
    const maximum = vm.stack[2]!;
    expect('value' in maximum && maximum.value).toBeGreaterThan(75);
  });
  it.each([
    ['10 20 moveto currentpoint', [10, 20]],
    ['10 20 moveto 10 20 translate currentpoint', [0, 0]],
    ['10 20 moveto 3 4 rmoveto currentpoint', [13, 24]],
    ['10 20 moveto 3 4 rlineto currentpoint', [13, 24]],
    ['10 20 moveto 1 2 3 4 5 6 rcurveto currentpoint', [15, 26]],
    ['10 20 moveto 1 2 3 4 5 6 curveto currentpoint', [5, 6]],
    ['10 20 moveto 30 40 lineto closepath currentpoint', [10, 20]],
    ['10 20 moveto 30 40 lineto pathbbox', [10, 20, 30, 40]],
    ['0 0 moveto 0 100 10 100 10 0 curveto pathbbox', [0, 0, 10, 100]],
    ['0 0 moveto 10 10 lineto 100 100 moveto pathbbox', [0, 0, 10, 10]],
    ['0 0 moveto 10 0 lineto [1 1 0 1 0 0] concat pathbbox', [0, -10, 10, 0]],
    ['10 20 moveto -1 -2 100 200 setbbox pathbbox', [-1, -2, 100, 200]],
    ['1 2 moveto gsave newpath 9 9 moveto grestore currentpoint', [1, 2]],
    ['1 2 moveto /s save def 9 9 moveto gsave 8 8 moveto s restore currentpoint', [1, 2]],
    ['1 2 moveto /s save def 9 9 moveto gsave 8 8 moveto grestoreall currentpoint s restore currentpoint', [1, 2, 1, 2]],
  ])('evaluates %s', (source, expected) => {
    const { vm } = runGraphics(source);
    expect(vm.stack.map(value => 'value' in value ? value.value : value.kind)).toEqual(expected);
  });

  it('retains coordinates where each segment was constructed', () => {
    const { graphics } = runGraphics('10 20 moveto 10 20 translate 1 2 lineto');
    expect(graphics.state.path.segments).toEqual([
      { op: 'M', x: 10, y: 20 }, { op: 'L', x: 11, y: 22 },
    ]);
  });

  it('constructs cubic circles and preserves clockwise endpoint direction', () => {
    const { graphics } = runGraphics('0 0 10 0 90 arc 0 0 10 90 0 arcn');
    expect(graphics.state.path.segments[0]).toEqual({ op: 'M', x: 10, y: 0 });
    const curves = graphics.state.path.segments.filter(segment => segment.op === 'C');
    expect(curves).toHaveLength(2);
    expect(curves[0]).toMatchObject({ op: 'C', y: 10 });
    expect(curves[1]).toMatchObject({ op: 'C', x: 10, y: 0 });
  });

  it('returns tangent points for arcto', () => {
    const { vm } = runGraphics('0 0 moveto 10 0 10 10 2 arcto');
    const values = vm.stack.map(value => 'value' in value ? Number(value.value) : NaN);
    expect(values[0]).toBeCloseTo(8);
    expect(values[1]).toBeCloseTo(0);
    expect(values[2]).toBeCloseTo(10);
    expect(values[3]).toBeCloseTo(2);
  });

  it('normalizes finite huge angles without a native range error', () => {
    expect(() => runGraphics('0 0 1 1e308 -1e308 arc')).not.toThrow();
  });

  it.each(['currentpoint', '1 2 lineto', '1 2 rmoveto', '1 2 rlineto', '1 2 3 4 5 6 curveto', 'pathbbox'])
  ('reports nocurrentpoint for %s', source => {
    expect(() => runGraphics(source)).toThrow(/nocurrentpoint/);
  });
});
