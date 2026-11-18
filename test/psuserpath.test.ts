import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
import { strokeOutlinePolys } from '../src/strokegeom.js';

describe('PostScript path transformations and user paths', () => {
  it('enumerates a snapshot while callbacks build another path', () => {
    const { vm } = runGraphics('1 2 moveto 3 4 lineto { newpath 9 9 moveto } {} {} {} pathforall currentpoint');
    expect(vm.stack).toMatchObject([{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 9 }, { value: 9 }]);
  });

  it('permits exit from pathforall without exiting its caller', () => {
    const { vm } = runGraphics('1 2 moveto 3 4 lineto { exit } {} {} {} pathforall 7');
    expect(vm.stack).toMatchObject([{ value: 1 }, { value: 2 }, { value: 7 }]);
  });

  it('reverses cubic control points and endpoints', () => {
    const { graphics } = runGraphics('0 0 moveto 1 2 3 4 5 6 curveto reversepath');
    expect(graphics.state.path.segments).toEqual([
      { op: 'M', x: 5, y: 6 }, { op: 'C', x1: 3, y1: 4, x2: 1, y2: 2, x: 0, y: 0 },
    ]);
  });

  it('keeps a closed contour separate from a later open continuation when reversing', () => {
    const { graphics } = runGraphics('0 0 moveto 10 0 lineto closepath 20 0 lineto reversepath');
    expect(graphics.state.path.segments).toEqual([
      { op: 'M', x: 10, y: 0 }, { op: 'L', x: 0, y: 0 }, { op: 'Z' },
      { op: 'M', x: 20, y: 0 }, { op: 'L', x: 0, y: 0 },
    ]);
  });

  it('flattens curves with device-space flatness', () => {
    const { graphics } = runGraphics('0 0 moveto 0 10 10 10 10 0 curveto flattenpath');
    expect(graphics.state.path.segments.some(segment => segment.op === 'C')).toBe(false);
    expect(graphics.state.path.current).toEqual([10, 0]);
    expect(graphics.state.path.segments.length).toBeGreaterThan(3);
  });

  it.each([
    ['[0 0 10 10 /setbbox 1 2 /moveto 3 4 /lineto] uappend currentpoint', [3, 4]],
    ['[[0 0 10 10 1 2 3 4] <000103>] uappend currentpoint', [3, 4]],
    ['1 2 moveto 3 4 lineto false upath newpath uappend currentpoint', [3, 4]],
    ['1 2 moveto 3 4 lineto true upath newpath uappend currentpoint', [3, 4]],
    ['5 5 moveto 15 5 lineto strokepath pathbbox', [5, 4.5, 15, 5.5]],
    ['0 0 moveto 10 0 lineto 2 3 scale strokepath pathbbox', [0, -0.5, 5, 0.5]],
    ['[0 0 10 10 /setbbox 1 5 /moveto 9 5 /lineto] [1 0 0 3 0 0] ustrokepath pathbbox', [1, 3.5, 9, 6.5]],
  ])('evaluates %s', (source, expected) => {
    const { vm } = runGraphics(source);
    expect(vm.stack).toHaveLength(expected.length);
    vm.stack.forEach((value, index) => expect('value' in value ? value.value : NaN).toBeCloseTo(expected[index]!, 8));
  });

  it.each([
    ['[[0 0 10 10] <000c>] uappend', 'typecheck'],
    ['[[0 0 10 10] <00ff>] uappend', 'rangecheck'],
    ['[[0 0 10] <00>] uappend', 'rangecheck'],
    ['[0 0 10 10 /setbbox /showpage] uappend', 'typecheck'],
  ])('refuses malformed user paths %s', (source, error) => {
    expect(() => runGraphics(source)).toThrow(new RegExp(error));
  });

  it('meters dash expansion inside the shared stroke helper', () => {
    const budget = new PsBudget(LoadLimits.defaults.with({ maxPostScriptOperations: 100 }));
    expect(() => strokeOutlinePolys([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 1, y: 0 }],
      [1, 0, 0, 1, 0, 0], { width: 1, cap: 0, join: 0, miter: 10, dash: [0.001, 0.001], dashPhase: 0 },
      { budget, pixelSize: 72 / 250, tolerance: 72 / 250 },
    )).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
  });

  it('does not tessellate round pieces for a straight butt-cap stroke', () => {
    const budget = new PsBudget(LoadLimits.defaults.with({ maxPostScriptOperations: 100 }));
    expect(() => strokeOutlinePolys([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 1, y: 0 }],
      [1, 0, 0, 1, 0, 0], { width: 1, cap: 0, join: 0, miter: 10, dash: [], dashPhase: 0 },
      { budget, pixelSize: 72 / 250, tolerance: 0 },
    )).not.toThrow();
  });
});
