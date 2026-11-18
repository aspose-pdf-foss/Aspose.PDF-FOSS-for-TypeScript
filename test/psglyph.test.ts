import { describe, expect, it } from 'vitest';
import { runPsFonts, psTextBytes } from './helpers/ps-text.js';
import { PsGlyphRunner, type PsGlyphResult } from '../src/psglyph.js';
import { parseContentStream } from '../src/content.js';

function runGlyph(builder: string, mode: 'show' | 'measure' | 'path' = 'show', key = 'BuildGlyph') {
  const setup = runPsFonts(), { vm, graphics, fonts } = setup, runner = new PsGlyphRunner(vm, graphics, fonts);
  let result: PsGlyphResult | undefined;
  vm.registerOperator('probeGlyph', () => { const font = fonts.current(); runner.run({ font, root: font.dictionary, code: 65, name: 'A', matrix: font.matrix }, mode, value => { result = value; }); });
  vm.run(psTextBytes(`/G << /FontType 3 /FontMatrix [.01 0 0 .01 0 0] /FontBBox [0 0 1 1] /Encoding StandardEncoding /${key} ${builder} >> definefont setfont probeGlyph`));
  return { ...setup, runner, result };
}
describe('procedure glyph invocation scopes', () => {
  it('captures BuildGlyph operands, vector advances and complete paint', () => {
    const { result, vm } = runGlyph('{ /given exch def /givenfont exch def 600 30 setcharwidth 0 0 100 200 rectfill }');
    expect(vm.lookup('given')).toMatchObject({ text: 'A' }); expect(vm.lookup('givenfont')).toMatchObject({ kind: 'dictionary' });
    expect(result!.glyph.advance).toEqual([600, 30]); expect(result!.glyph.box).toEqual([0, 0, 100, 200]);
    expect(parseContentStream(result!.paint!.content).some(op => op.operator === 'f')).toBe(true);
  });
  it('falls back to BuildChar with the actual code', () => {
    const { vm } = runGlyph('{ /given exch def pop 500 0 setcharwidth }', 'measure', 'BuildChar'); expect(vm.lookup('given')).toMatchObject({ value: 65 });
  });
  it('executes dictionary side effects during nonpublishing measurement', () => {
    const { result, graphics, vm } = runGlyph('{ pop pop /visited 7 def 500 0 setcharwidth 0 0 100 100 rectfill }', 'measure');
    expect(vm.lookup('visited')).toMatchObject({ value: 7 }); expect(result!.paint).toBeUndefined(); expect(graphics.finish()).toHaveLength(0);
  });
  it('collects path paint but omits image portions from a mixed glyph', () => {
    const { result } = runGlyph('{ pop pop 500 0 setcharwidth 0 0 100 100 rectfill 1 1 8 [1 0 0 1 0 0] <ff> image }', 'path');
    expect(result!.glyph.path.segments.filter(s => s.op === 'L')).toHaveLength(3); expect(result!.paint).toBeUndefined();
  });
  it('preserves glyph transform and boundary across grestoreall', () => {
    const { result } = runGlyph('{ pop pop 500 0 setcharwidth gsave 10 20 translate grestoreall 0 0 100 200 rectfill }', 'path');
    expect(result!.glyph.path.segments[0]).toEqual({ op: 'M', x: 0, y: 0 }); expect(result!.glyph.box).toEqual([0, 0, 100, 200]);
  });
  it.each(['{ pop pop }', '{ pop pop 0 0 1 1 rectfill 500 0 setcharwidth }', '{ pop pop 500 0 setcharwidth 500 0 setcharwidth }'])('rejects missing/late/duplicate metrics: %s', builder => {
    expect(() => runGlyph(builder)).toThrow(/undefined/);
  });
  it('enforces cachedevice color restrictions and validates both cachedevice2 metric sets', () => {
    expect(() => runGlyph('{ pop pop 500 0 0 0 100 100 setcachedevice 1 0 0 setrgbcolor }')).toThrow(/undefined/);
    const { result } = runGlyph('{ pop pop 600 30 0 0 100 100 20 -600 0 0 setcachedevice2 0 0 100 100 rectfill }');
    expect(result!.glyph.advance).toEqual([600, 30]); expect(result!.paint!.colored).toBe(false);
  });
  it.each(['stop', 'quit', 'exit'])('restores exited glyph scopes after %s', escape => {
    const setup = runPsFonts(), { vm, graphics, fonts } = setup, runner = new PsGlyphRunner(vm, graphics, fonts), old = graphics.state;
    vm.registerOperator('probeGlyph', () => { const font = fonts.current(); runner.run({ font, root: font.dictionary, code: 65, name: 'A', matrix: font.matrix }, 'show', () => {}); });
    const call = escape === 'stop' ? '{ probeGlyph } stopped pop' : escape === 'exit' ? '{ probeGlyph } loop' : 'probeGlyph';
    vm.run(psTextBytes(`/G << /FontType 3 /FontMatrix [.01 0 0 .01 0 0] /FontBBox [0 0 1 1] /Encoding StandardEncoding /BuildGlyph { pop pop 500 0 setcharwidth ${escape} } >> definefont setfont ${call}`));
    expect(graphics.state).toBe(old); vm.run(psTextBytes('clear 1 2 add')); expect(vm.peek()).toMatchObject({ value: 3 });
  });
});
