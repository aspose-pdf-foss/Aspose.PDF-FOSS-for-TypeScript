import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { Document } from '../src/document.js';
import { appendPsPages } from '../src/pspdf.js';
import { parseContentStream } from '../src/content.js';
import { decodeStream } from '../src/filters.js';
import { isDict, name } from '../src/types.js';
import { LoadLimits } from '../src/loadlimits.js';
import { UnsupportedFeatureError } from '../src/errors.js';

describe('PostScript colors and line state', () => {
  it.each([
    ['0.2 0.3 0.4 0.5 setcmykcolor currentcolor', [0.2, 0.3, 0.4, 0.5]],
    ['-1 0.5 2 setrgbcolor currentrgbcolor', [0, 0.5, 1]],
    ['0.2 0.3 0.4 0.5 setcmykcolor currentrgbcolor', [0.3, 0.2, 0.1]],
    ['0.5 setgray currentcmykcolor', [0, 0, 0, 0.5]],
    ['0.2 0.4 0.6 setrgbcolor currentcmykcolor', [0.4, 0.2, 0, 0.4]],
    ['1 0 0 setrgbcolor currentgray', [0.3]],
    ['0.5 setgray currentrgbcolor', [0.5, 0.5, 0.5]],
    ['0.5 1 1 sethsbcolor currentrgbcolor', [0, 1, 1]],
    ['2 1 1 sethsbcolor currentrgbcolor', [1, 0, 0]],
    ['0 1 0 setrgbcolor currenthsbcolor', [1 / 3, 1, 1]],
    ['/DeviceRGB setcolorspace currentcolor', [0, 0, 0]],
    ['[/DeviceCMYK] setcolorspace currentcolor', [0, 0, 0, 1]],
    ['[/Pattern] setcolorspace currentcmykcolor', [0, 0, 0, 0]],
    ['[/Indexed /DeviceRGB 1 <ff000000ff00>] setcolorspace 1 setcolor currentrgbcolor', [0, 1, 0]],
    ['[/Indexed /DeviceRGB 1 { dup 1 exch sub 0 }] setcolorspace 1 setcolor currentrgbcolor', [1, 0, 0]],
    ['[/Separation /Spot /DeviceRGB { dup mul dup 0 }] setcolorspace 0.5 setcolor currentcolor currentrgbcolor', [0.5, 0.25, 0.25, 0]],
    ['[/DeviceN [/A /B] /DeviceRGB { 0 }] setcolorspace 0.25 0.75 setcolor currentcolor currentrgbcolor', [0.25, 0.75, 0.25, 0.75, 0]],
    ['[/Separation (Spot) /DeviceGray { dup mul }] setcolorspace 0.5 setcolor currentgray', [0.25]],
    ['[/Separation /All null null] setcolorspace 0.25 setcolor currentcmykcolor', [0.25, 0.25, 0.25, 0.25]],
    ['[/Separation /Cyan null null] setcolorspace 0.25 setcolor currentcmykcolor', [0.25, 0, 0, 0]],
    ['[/DeviceN [(Cyan) /Black] null null] setcolorspace 0.25 0.75 setcolor currentcmykcolor', [0.25, 0, 0, 0.75]],
    ['2 setlinewidth currentlinewidth', [2]],
    ['-2 setlinewidth currentlinewidth', [2]],
    ['2 setlinecap 1 setlinejoin 5 setmiterlimit currentlinecap currentlinejoin currentmiterlimit', [2, 1, 5]],
    ['-1 setflat currentflat 200 setflat currentflat', [0.2, 100]],
    ['true setoverprint true setstrokeadjust currentoverprint currentstrokeadjust', [true, true]],
    ['/a [1 2] def a 3 setdash a 0 9 put currentdash exch 0 get', [3, 9]],
  ])('evaluates %s', (source, expected) => {
    const { vm } = runGraphics(source);
    expect(vm.stack).toHaveLength(expected.length);
    vm.stack.forEach((value, i) => {
      const actual = 'value' in value ? value.value : value.kind;
      if (typeof expected[i] === 'number') expect(actual).toBeCloseTo(expected[i] as number, 8);
      else expect(actual).toBe(expected[i]);
    });
  });

  it('reports currentcolorspace as an array and restores the source components', () => {
    const { vm } = runGraphics('0.2 0.3 0.4 setrgbcolor gsave 0 setgray grestore currentcolorspace 0 get currentcolor');
    expect(vm.stack).toMatchObject([{ text: 'DeviceRGB' }, { value: 0.2 }, { value: 0.3 }, { value: 0.4 }]);
  });

  it('preserves native device color and line parameters in saved PDF', () => {
    const { graphics } = runGraphics('0.2 0.3 0.4 0.5 setcmykcolor 2 setlinewidth [1 2] 3 setdash 0 0 moveto 10 10 lineto stroke showpage');
    const doc = Document.New();
    appendPsPages(doc, graphics.finish());
    const reopened = Document.Open(doc.Save());
    const ops = parseContentStream(reopened.Pages[0]!.Contents);
    expect(ops.find(op => op.operator === 'K')?.operands).toEqual([0.2, 0.3, 0.4, 0.5]);
    expect(ops.find(op => op.operator === 'd')?.operands).toEqual([[1, 2], 3]);
  });

  it('emits overprint and stroke adjustment as PDF graphics-state parameters', () => {
    const { graphics } = runGraphics('true setoverprint true setstrokeadjust 0 0 10 10 rectfill showpage');
    const doc = Document.New();
    appendPsPages(doc, graphics.finish());
    const resources = doc.Pages[0]!.Dict.get('Resources');
    const states = isDict(resources) ? resources.get('ExtGState') : undefined;
    expect(isDict(states)).toBe(true);
    const values = isDict(states) ? [...states.values()].map(value => doc.resolve(value)) : [];
    expect(values.some(value => isDict(value) && value.get('OP') === true && value.get('op') === true && value.get('SA') === true)).toBe(true);
  });

  it('resumes tint callbacks after a returning error handler', () => {
    const { vm } = runGraphics('errordict /undefined { pop } put [/Separation /Spot /DeviceGray { missing dup mul }] setcolorspace 0.5 setcolor currentgray');
    expect(vm.stack).toMatchObject([{ value: 0.25 }]);
  });

  it('does not commit a tint color when the callback stops outside its scope', () => {
    const { vm } = runGraphics('0.25 setgray { [/Separation /Spot /DeviceGray { stop }] setcolorspace } stopped currentgray');
    expect(vm.stack).toMatchObject([{ value: 1 }, { value: true }, { value: 0.25 }]);
  });

  it.each([
    ['3 setlinecap', 'rangecheck'], ['-1 setlinejoin', 'rangecheck'],
    ['0.5 setmiterlimit', 'rangecheck'], ['[0 0] 0 setdash', 'rangecheck'],
    ['[-1 2] 0 setdash', 'rangecheck'], ['[1 /x] 0 setdash', 'typecheck'],
    ['[/Indexed /DeviceRGB 1 <ff00>] setcolorspace', 'rangecheck'],
    ['[/Separation /Spot /DeviceRGB { pop /bad 0 0 }] setcolorspace', 'typecheck'],
    ['[/DeviceN [/None] /DeviceGray { pop 0 }] setcolorspace', 'rangecheck'],
  ])('refuses %s', (source, error) => {
    expect(() => runGraphics(source)).toThrow(new RegExp(error));
  });

  it('retains a dash source in the global/local barrier and restores journals', () => {
    expect(() => runGraphics('[1 2] 0 setdash true setglobal gstate')).toThrow(/invalidaccess/);
    const { vm } = runGraphics('/a [1 2] def a 0 setdash /s save def [3 4] 0 setdash s restore currentdash pop 0 get');
    expect(vm.stack).toMatchObject([{ value: 1 }]);
  });

  it('propagates resource exhaustion out of recursive tint callbacks and stopped', () => {
    expect(() => runGraphics('/p /p cvx def { [/Separation /Spot /DeviceGray { p }] setcolorspace } stopped',
      LoadLimits.defaults.with({ maxPostScriptOperations: 100000 })))
      .toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
  });

  it('retains parsed color callback roots before prospective restore mutation', () => {
    const { vm } = runGraphics('/lookup { pop s restore 0.5 } def '
      + '/desc [/Indexed [/Separation /Spot /DeviceGray { dup }] 0 /lookup load] def /witness 0 def');
    expect(() => vm.run(new TextEncoder().encode('/s save def /witness 1 def '
      + 'desc 1 get 3 { dup mul } put desc setcolorspace'))).toThrow(/invalidrestore/);
    expect(vm.lookup('witness')).toMatchObject({ value: 1 });
  });

  it('suppresses marking for the None colorant', () => {
    const { graphics } = runGraphics('[/Separation /None null { stop }] setcolorspace 0 setcolor 0 0 10 10 rectfill showpage');
    expect(parseContentStream(graphics.finish()[0]!.content).some(op => op.operator === 'f')).toBe(false);
  });

  it.each(['[/CIEBasedABC << >>] setcolorspace', '<< >> shfill', '<< >> sethalftone'])
  ('refuses unsupported graphics facilities in %s', source => {
    expect(() => runGraphics(source)).toThrow(UnsupportedFeatureError);
  });
});
