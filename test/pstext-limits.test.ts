import { describe, expect, it } from 'vitest';
import { runPsText, runPsFonts, psTextBytes } from './helpers/ps-text.js';
import { LoadLimits } from '../src/loadlimits.js';
import { name, integer, real } from '../src/psvalue.js';
const empty = '/Empty << /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 0 0] /Encoding StandardEncoding /BuildGlyph { pop pop 0 0 setcharwidth } >> definefont setfont ';
describe('cumulative PostScript font/text limits', () => {
  it('bounds repeated cached measurement across run boundaries', () => {
    const { vm } = runPsText('', { limits: LoadLimits.defaults.with({ maxPostScriptOperations: 1_000_000 }) });
    vm.run(psTextBytes('(A) stringwidth pop pop'));
    expect(() => vm.run(psTextBytes('{ (AA) stringwidth pop pop } loop'))).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations', allowed: 1_000_000 }));
  });
  it('bounds empty procedure glyph allocation even when measurement publishes nothing', () => {
    const { vm, graphics } = runPsText(empty, { limits: LoadLimits.defaults.with({ maxPostScriptVmBytes: 2_000_000 }) });
    const state = graphics.state;
    expect(() => vm.run(psTextBytes('{ (A) stringwidth pop pop } loop'))).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes', allowed: 2_000_000 }));
    expect(graphics.state).toBe(state);
  });
  it('checks encoding/container and object lengths before source growth', () => {
    expect(() => runPsText('2000 array', { limits: LoadLimits.defaults.with({ maxContainerItems: 1024 }) })).toThrowError(expect.objectContaining({ limit: 'maxContainerItems', reached: 2000, allowed: 1024 }));
    expect(() => runPsText('8193 string', { limits: LoadLimits.defaults.with({ maxObjectBytes: 8192 }) })).toThrowError(expect.objectContaining({ limit: 'maxObjectBytes', reached: 8193, allowed: 8192 }));
  });
  it('applies a configured smaller composite depth before publishing a font', () => {
    const { vm, fonts } = runPsFonts('', { limits: LoadLimits.defaults.with({ maxNestingDepth: 4 }) });
    let descendant = fonts.find(name('Courier'));
    const next = () => {
      const d = vm.memory.dictionary();
      vm.memory.put(d, name('FontType'), integer(0)); vm.memory.put(d, name('FontMatrix'), vm.memory.arrayFrom([1, 0, 0, 1, 0, 0].map(real)));
      vm.memory.put(d, name('FMapType'), integer(2)); vm.memory.put(d, name('Encoding'), vm.memory.arrayFrom([integer(0)]));
      vm.memory.put(d, name('FDepVector'), vm.memory.arrayFrom([descendant])); return fonts.define(name('Deep'), d);
    };
    for (let i = 0; i < 4; i++) descendant = next();
    expect(next).toThrowError(expect.objectContaining({ limit: 'maxNestingDepth', reached: 5, allowed: 4, detail: 'composite fonts' }));
  });
  it('restores a failed glyph capture and permits later source execution', () => {
    const { vm, graphics } = runPsText(); const state = graphics.state;
    expect(() => vm.run(psTextBytes('/Bad << /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 1 1] /Encoding StandardEncoding /BuildGlyph { pop pop 0 0 1 1 rectfill } >> definefont setfont (A) stringwidth'))).toThrow(/undefined/);
    expect(graphics.state).toBe(state); vm.run(psTextBytes('clear 1 2 add')); expect(vm.peek()).toMatchObject({ value: 3 });
  });
  it('bounds output-only glyph growth before an incomplete text block is published', () => {
    const { vm } = runPsText(empty + '0 0 moveto', { limits: LoadLimits.defaults.with({ maxContentBytes: 1000 }) });
    expect(() => vm.run(psTextBytes('0 1 1000 { 20 string cvs cvn glyphshow } for'))).toThrowError(expect.objectContaining({ limit: 'maxContentBytes', allowed: 1000 }));
  });
});
