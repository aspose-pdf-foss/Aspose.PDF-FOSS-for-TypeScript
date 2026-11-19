import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { parseContentStream } from '../src/content.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { LoadLimits } from '../src/loadlimits.js';
import { UnsupportedFeatureError } from '../src/errors.js';

describe('PostScript page lifecycle', () => {
  it('emits explicit blank pages and finalizes idempotently', () => {
    const { graphics } = runGraphics('showpage showpage');
    expect(graphics.finish()).toHaveLength(2);
    expect(graphics.finish()).toHaveLength(2);
  });

  it('includes a trailing marked page once and omits an unmarked trailing page', () => {
    const { graphics } = runGraphics('0 0 10 10 rectfill');
    const first = graphics.finish();
    expect(first).toHaveLength(1);
    expect(graphics.finish()).toBe(first);
    expect(runGraphics('1 2 moveto').graphics.finish()).toHaveLength(0);
  });

  it('retains marks across copypage and discards marks on erasepage', () => {
    const { graphics } = runGraphics('0 0 1 1 rectfill copypage 2 2 3 3 rectfill showpage 0 0 5 5 rectfill erasepage showpage');
    const pages = graphics.finish();
    expect(pages).toHaveLength(3);
    expect(pages.map(page => parseContentStream(page.content).filter(op => op.operator === 'f').length)).toEqual([1, 2, 0]);
  });

  it('resets the current path and matrix after showpage', () => {
    const { vm } = runGraphics('3 4 translate 1 2 moveto showpage 0 0 transform');
    expect(vm.stack).toMatchObject([{ value: 0 }, { value: 0 }]);
  });

  it.each(['showpage', '<< /PageSize [20 30] >> setpagedevice', 'nulldevice'])
    ('keeps the established graphics-parameter defaults after %s', transition => {
      const { vm } = runGraphics('7 setflat true setstrokeadjust true setoverprint '
        + `${transition} currentflat currentstrokeadjust currentoverprint`);
      expect(vm.stack).toMatchObject([{ value: 1 }, { value: false }, { value: false }]);
    });

  it('continues pages and definitions across repeated run calls', () => {
    const { vm, graphics } = runGraphics('/x 7 def 0 0 1 1 rectfill showpage');
    vm.run(new TextEncoder().encode('x 0 0 2 2 rectfill showpage'));
    expect(vm.stack).toMatchObject([{ value: 7 }]);
    expect(graphics.finish()).toHaveLength(2);
  });

  it('resizes the device and reports PageSize', () => {
    const { vm, graphics } = runGraphics('<< /PageSize [20 30] >> setpagedevice currentpagedevice /PageSize get aload pop showpage');
    expect(vm.stack).toMatchObject([{ value: 20 }, { value: 30 }]);
    expect(graphics.finish()[0]!.box).toEqual([0, 0, 20, 30]);
  });

  it('publishes marked content before a changed page size', () => {
    const { graphics } = runGraphics('0 0 5 5 rectfill << /PageSize [20 30] >> setpagedevice showpage');
    expect(graphics.finish().map(page => page.box)).toEqual([[0, 0, 595, 842], [0, 0, 20, 30]]);
  });

  it('restores the real device after a null-device scope', () => {
    const { graphics } = runGraphics('gsave nulldevice 0 0 10 10 rectfill showpage grestore 0 0 5 5 rectfill showpage');
    expect(graphics.finish()).toHaveLength(1);
  });

  it.each([
    ['<< /PageSize [-1 20] >> setpagedevice', 'rangecheck'],
    ['<< /PageSize [20] >> setpagedevice', 'rangecheck'],
    ['<< /PageSize [20 /x] >> setpagedevice', 'typecheck'],
  ])('refuses invalid page dimensions in %s', (source, fault) => {
    expect(() => runGraphics(source)).toThrow(new RegExp(fault));
  });

  it('refuses unsupported page-device requests explicitly', () => {
    expect(() => runGraphics('<< /Duplex true >> setpagedevice')).toThrow(UnsupportedFeatureError);
  });

  it('discards an incomplete paint block when an output limit interrupts it', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxContentBytes: 40 }) });
    const graphics = installPsGraphics(vm);
    expect(() => vm.run(new TextEncoder().encode('0 0 100 100 rectfill')))
      .toThrowError(expect.objectContaining({ limit: 'maxContentBytes' }));
    expect(graphics.finish()).toHaveLength(0);
  });
});
