import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { LoadLimits } from '../src/loadlimits.js';

describe('PostScript graphics state objects', () => {
  it('keeps graphics optional in the language interpreter', () => {
    const vm = new PsInterpreter();
    expect(vm.lookup('moveto')).toBeUndefined();
  });

  it('exposes installed standard operators to systemdict feature probes', () => {
    const { vm } = runGraphics('systemdict /moveto known systemdict /setrgbcolor known');
    expect(vm.stack).toMatchObject([{ value: true }, { value: true }]);
  });

  it('keeps systemdict readonly while permitting ordinary user shadows', () => {
    const { vm } = runGraphics('{ systemdict /moveto 7 put } stopped '
      + 'clear /moveto { pop pop } def 1 2 moveto systemdict /moveto get type');
    expect(vm.stack).toMatchObject([{ text: 'operatortype' }]);
  });

  it.each([
    ['1 2 moveto /g gstate def 9 9 moveto g setgstate currentpoint', [1, 2]],
    ['gstate type', ['gstatetype']],
    ['gstate dup eq', [true]],
    ['gstate gstate eq', [false]],
    ['true setglobal gstate gcheck', [true]],
    ['gstate gcheck', [false]],
    ['1 2 moveto /a gstate def /b gstate def 9 9 moveto b currentgstate pop a b copy pop b setgstate currentpoint', [1, 2]],
    ['1 2 moveto gstate 9 9 moveto currentgstate setgstate currentpoint', [9, 9]],
  ])('evaluates %s', (source, expected) => {
    const { vm } = runGraphics(source);
    expect(vm.stack.map(value => 'value' in value ? value.value : value.kind === 'name' ? value.text : value.kind)).toEqual(expected);
  });

  it.each([
    ['7 setflat initgraphics currentflat', 7],
    ['true setstrokeadjust initgraphics currentstrokeadjust', true],
    ['true setoverprint initgraphics currentoverprint', true],
  ])('preserves the graphics parameter in %s', (source, value) => {
    expect(runGraphics(source).vm.stack).toMatchObject([{ value }]);
  });

  it('resets the active clip while retaining each saved clip', () => {
    const { vm } = runGraphics('10 20 30 40 rectclip clipsave 12 24 7 8 rectclip clipsave '
      + '13 25 1 1 rectclip initgraphics clippath pathbbox '
      + 'cliprestore clippath pathbbox cliprestore clippath pathbbox');
    expect(vm.stack).toMatchObject([
      0, 0, 595, 842,
      12, 24, 19, 32,
      10, 20, 40, 60,
    ].map(value => ({ value })));
  });

  it('resets the matrix, current point, color and line properties with initgraphics', () => {
    const { vm } = runGraphics('6 7 translate 1 2 moveto 1 0 0 setrgbcolor 3 setlinewidth '
      + '1 setlinecap 2 setlinejoin 5 setmiterlimit [2 4] 3 setdash initgraphics '
      + '{ currentpoint } stopped 0 0 transform currentcolorspace 0 get currentgray '
      + 'currentlinewidth currentlinecap currentlinejoin currentmiterlimit currentdash exch length');
    expect(vm.stack.map(value => 'value' in value ? value.value : value.kind === 'name' ? value.text : value.kind))
      .toEqual([true, 0, 0, 'DeviceGray', 0, 1, 0, 0, 10, 0, 0]);
  });

  it('restores journaled older gstate objects', () => {
    const { vm } = runGraphics('1 2 moveto /g gstate def /s save def 9 9 moveto g currentgstate pop s restore g setgstate currentpoint');
    expect(vm.stack).toMatchObject([{ value: 1 }, { value: 2 }]);
  });

  it('rejects a retained newer local gstate before restoring graphics', () => {
    expect(() => runGraphics('/s save def gstate s restore')).toThrow(/invalidrestore/);
  });

  it('refuses a local state reference in global storage', () => {
    expect(() => runGraphics('/g gstate def true setglobal 1 array dup 0 g put')).toThrow(/invalidaccess/);
  });

  it('checks state access before writing', () => {
    expect(() => runGraphics('gstate readonly currentgstate')).toThrow(/invalidaccess/);
  });

  it('replaces optional state attributes when installing a gstate', () => {
    const vm = new PsInterpreter();
    const graphics = installPsGraphics(vm);
    vm.registerOperator('dashref', () => { graphics.state.sourceDash = vm.memory.array(1); });
    vm.run(new TextEncoder().encode('/g gstate def dashref g setgstate'));
    expect(graphics.state.sourceDash).toBeUndefined();
  });

  it('isolates the parent graphics stack inside a paint scope', () => {
    const vm = new PsInterpreter();
    const graphics = installPsGraphics(vm);
    vm.registerOperator('scope', () => {
      const proc = vm.procedure();
      vm.replace(1);
      vm.invoke(proc, graphics.withPaintScope(() => {}, () => {}));
    });
    vm.run(new TextEncoder().encode('0 0 moveto gsave 1 2 moveto { grestore currentpoint } scope grestore currentpoint'));
    expect(vm.stack).toMatchObject([{ value: 1 }, { value: 2 }, { value: 0 }, { value: 0 }]);
  });

  it('retains saved parent stack roots until a paint scope has unwound', () => {
    const vm = new PsInterpreter();
    const graphics = installPsGraphics(vm);
    vm.registerOperator('dashref', () => {
      graphics.state.sourceDash = vm.memory.array(1);
      graphics.saveState();
      graphics.state.sourceDash = undefined;
    });
    vm.registerOperator('scope', () => {
      const proc = vm.procedure();
      vm.replace(1);
      vm.invoke(proc, graphics.withPaintScope(() => {}, () => {}));
    });
    expect(() => vm.run(new TextEncoder().encode('/restoreproc { s restore } def /s save def dashref /restoreproc load scope')))
      .toThrow(/invalidrestore/);
  });

  it('meters state and path growth before native overflow', () => {
    expect(() => runGraphics('{ gsave } loop', LoadLimits.defaults.with({ maxNestingDepth: 8 })))
      .toThrowError(expect.objectContaining({ limit: 'maxNestingDepth' }));
    expect(() => runGraphics('0 0 moveto { 1 1 rlineto } loop', LoadLimits.defaults.with({ maxContainerItems: 1000 })))
      .toThrowError(expect.objectContaining({ limit: 'maxContainerItems', reached: 1001, detail: 'path segments' }));
  });
});
