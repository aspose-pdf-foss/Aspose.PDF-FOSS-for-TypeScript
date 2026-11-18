import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import type { Path } from '../src/pagerender.js';

function contains(path: Path, x: number, y: number): boolean {
  let winding = 0;
  let px = 0, py = 0, sx = 0, sy = 0;
  const edge = (ax: number, ay: number, bx: number, by: number): void => {
    const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y && by > y && cross > 0) winding++;
    if (by <= y && ay > y && cross < 0) winding--;
  };
  for (const segment of path) {
    if (segment.op === 'M') { px = sx = segment.x; py = sy = segment.y; }
    else if (segment.op === 'L') { edge(px, py, segment.x, segment.y); px = segment.x; py = segment.y; }
    else if (segment.op === 'Z') { edge(px, py, sx, sy); px = sx; py = sy; }
    else throw new Error('Expected a materialized linear clipping boundary');
  }
  return winding !== 0;
}

describe('PostScript clipping regions', () => {
  it.each([
    ['0 0 10 10 rectclip 5 0 10 10 rectclip clippath pathbbox', [5, 0, 10, 10]],
    ['0 0 10 10 rectclip gsave 5 0 10 10 rectclip grestore clippath pathbbox', [0, 0, 10, 10]],
    ['0 0 10 10 rectclip clipsave 5 0 10 10 rectclip cliprestore clippath pathbbox', [0, 0, 10, 10]],
    ['0 0 10 10 rectclip initclip clippath pathbbox', [0, 0, 595, 842]],
    ['[0 0 10 10 20 0 10 10] rectclip clippath pathbbox', [0, 0, 30, 10]],
  ])('evaluates %s', (source, expected) => {
    const { vm } = runGraphics(source);
    expect(vm.stack.map(value => 'value' in value ? value.value : value.kind)).toEqual(expected);
  });

  it('preserves the current path when clipping', () => {
    const { vm } = runGraphics('1 2 moveto 3 4 lineto clip currentpoint');
    expect(vm.stack).toMatchObject([{ value: 3 }, { value: 4 }]);
  });

  it.each([
    ['0 0 10 10 rectclip 5 0 10 10 rectclip', [[6, 5, true], [2, 5, false], [12, 5, false]]],
    ['0 0 10 10 rectclip 20 0 10 10 rectclip', [[5, 5, false], [25, 5, false]]],
    ['newpath 0 0 moveto 20 0 lineto 20 20 lineto 0 20 lineto closepath 5 5 moveto 15 5 lineto 15 15 lineto 5 15 lineto closepath eoclip', [[1, 1, true], [10, 10, false], [25, 1, false]]],
    ['newpath 0 0 moveto 2 0 lineto 2 2 lineto 0 2 lineto closepath 10 0 moveto 12 0 lineto 12 2 lineto 10 2 lineto closepath clip', [[1, 1, true], [11, 1, true], [5, 1, false]]],
    ['0 0 10 10 rectclip newpath 0 0 moveto 0 10 lineto 10 10 lineto 10 0 lineto closepath clip', [[5, 5, true], [15, 5, false]]],
    ['newpath 0 0 moveto 10 10 lineto 0 10 lineto 10 0 lineto closepath eoclip', [[5, 2, true], [1, 5, false], [5, 8, true]]],
    ['newpath 20 20 10 0 360 arc closepath clip', [[20, 20, true], [29, 29, false], [35, 20, false]]],
  ] as const)('materializes %s', (source, samples) => {
    const { graphics } = runGraphics(source + ' clippath');
    for (const [x, y, expected] of samples) expect(contains(graphics.state.path.segments, x, y)).toBe(expected);
  });
});
