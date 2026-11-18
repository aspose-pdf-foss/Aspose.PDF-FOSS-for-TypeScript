import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';

describe('PostScript matrices', () => {
  it.each([
    ['matrix aload pop', [1, 0, 0, 1, 0, 0]],
    ['10 20 translate matrix currentmatrix aload pop', [1, 0, 0, 1, 10, 20]],
    ['10 20 translate 2 3 scale 1 1 transform', [12, 23]],
    ['10 20 translate 2 3 scale 12 23 itransform', [1, 1]],
    ['10 20 translate 2 3 scale 1 1 dtransform', [2, 3]],
    ['10 20 translate 2 3 scale 2 3 idtransform', [1, 1]],
    ['10 20 matrix translate aload pop', [1, 0, 0, 1, 10, 20]],
    ['2 3 matrix scale aload pop', [2, 0, 0, 3, 0, 0]],
    ['[9 8 7 6 5 4] identmatrix aload pop', [1, 0, 0, 1, 0, 0]],
    ['[2 0 0 3 4 5] setmatrix matrix currentmatrix aload pop', [2, 0, 0, 3, 4, 5]],
    ['10 20 translate [2 0 0 3 0 0] concat 1 1 transform', [12, 23]],
    ['[1 0 0 1 10 20] [2 0 0 3 0 0] matrix concatmatrix aload pop', [2, 0, 0, 3, 20, 60]],
    ['[2 0 0 4 10 20] dup invertmatrix aload pop', [0.5, 0, 0, 0.25, -5, -5]],
    ['10 20 translate initmatrix 1 2 transform', [1, 2]],
    ['1 2 [2 0 0 3 10 20] transform', [12, 26]],
    ['12 26 [2 0 0 3 10 20] itransform', [1, 2]],
    ['1 2 [2 0 0 3 10 20] dtransform', [2, 6]],
  ])('evaluates %s', (source, expected) => {
    const { vm } = runGraphics(source);
    expect(vm.stack).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const value = vm.stack[i]!;
      expect(value.kind).toBe('real');
      expect('value' in value ? value.value : NaN).toBeCloseTo(expected[i]!, 10);
    }
  });

  it('uses the complete host default matrix and resets to it', () => {
    const vm = new PsInterpreter();
    installPsGraphics(vm, { box: [10, 20, 110, 220], defaultMatrix: [1, 0, 0, -1, -10, 220] });
    vm.run(new TextEncoder().encode('matrix defaultmatrix aload pop 3 4 translate initmatrix 10 20 transform'));
    expect(vm.stack.map(value => 'value' in value ? value.value : value.kind)).toEqual([1, 0, 0, -1, -10, 220, 0, 200]);
  });

  it('rotates without scaling a preceding translation', () => {
    const { vm } = runGraphics('10 20 translate 90 rotate 1 0 transform');
    expect(vm.stack[0]).toMatchObject({ kind: 'real', value: 10 });
    expect(vm.stack[1]).toMatchObject({ kind: 'real', value: 21 });
  });

  it.each([
    ['[1 0 0 1 0] setmatrix', 'rangecheck'],
    ['[1 0 0 1 0 0 0] setmatrix', 'rangecheck'],
    ['[1 0 0 1 /x 0] setmatrix', 'typecheck'],
    ['matrix readonly currentmatrix', 'invalidaccess'],
    ['matrix noaccess setmatrix', 'invalidaccess'],
    ['[0 0 0 0 0 0] matrix invertmatrix', 'undefinedresult'],
    ['0 0 scale 1 1 itransform', 'undefinedresult'],
  ])('refuses %s', (source, error) => {
    expect(() => runGraphics(source)).toThrow(new RegExp(error));
  });

  it('validates a destination before mutating it', () => {
    const { vm } = runGraphics('/m [9 8 7 6 5 4] def { m readonly currentmatrix } stopped pop m aload pop');
    expect(vm.stack.slice(-6).map(value => 'value' in value ? value.value : value.kind)).toEqual([9, 8, 7, 6, 5, 4]);
  });
});
