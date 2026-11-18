import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
describe('PostScript graphics hostile inputs', () => {
  it('bounds nested reader chains before decoding', () => {
    expect(() => runGraphics('(34313e>) /ASCIIHexDecode filter /ASCIIHexDecode filter',
      LoadLimits.defaults.with({ maxFilterChain: 1 })))
      .toThrowError(expect.objectContaining({ limit: 'maxFilterChain', allowed: 1, reached: 2 }));
  });
  it('bounds output tokens during source painting', () => {
    expect(() => runGraphics('0 0 1 1 rectfill', LoadLimits.defaults.with({ maxContentTokens: 20 })))
      .toThrowError(expect.objectContaining({ limit: 'maxContentTokens', allowed: 20, reached: 21, detail: 'PostScript output' }));
  });
  it('bounds page accumulation independently of marks', () => {
    expect(() => runGraphics('1001 { showpage } repeat', LoadLimits.defaults.with({ maxContainerItems: 1000 })))
      .toThrowError(expect.objectContaining({ limit: 'maxContainerItems', allowed: 1000, reached: 1001, detail: 'output pages' }));
  });
  it('counts the trailing marked page against the output page limit', () => {
    const { graphics } = runGraphics('1000 { showpage } repeat 0 0 1 1 rectfill',
      LoadLimits.defaults.with({ maxContainerItems: 1000 }));
    expect(() => graphics.finish())
      .toThrowError(expect.objectContaining({ limit: 'maxContainerItems', allowed: 1000, reached: 1001, detail: 'output pages' }));
  });
  it('charges VM allocation after installation and does not refund discarded output', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptVmBytes: 1048576 }) });
    installPsGraphics(vm);
    expect(() => vm.run(new TextEncoder().encode('{ 0 0 1 1 rectfill erasepage } loop')))
      .toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes', allowed: 1048576 }));
  });
  it('bounds recursive captures outside stopped', () => {
    expect(() => runGraphics('/f << /FormType 1 /BBox [0 0 1 1] /Matrix [1 0 0 1 0 0] '
      + '/PaintProc { pop f execform } >> def { f execform } stopped',
      LoadLimits.defaults.with({ maxNestingDepth: 16 })))
      .toThrowError(expect.objectContaining({ limit: 'maxNestingDepth', allowed: 16, reached: 17 }));
  });
  it('supports null limits on a finite graphics job', () => {
    expect(runGraphics('0 0 1 1 rectfill showpage', LoadLimits.defaults.with({
      maxPostScriptOperations: null, maxPostScriptVmBytes: null, maxContentTokens: null,
      maxContentBytes: null, maxNestingDepth: null, maxContainerItems: null,
    })).graphics.finish()).toHaveLength(1);
  });
  it('bounds tiny dash expansion before allocating all runs', () => {
    expect(() => runGraphics('[0.000001] 0 setdash 0 0 moveto 1000 0 lineto strokepath',
      LoadLimits.defaults.with({ maxContainerItems: 1000 })))
      .toThrowError(expect.objectContaining({ limit: 'maxContainerItems', allowed: 1000, reached: 1001, detail: 'dash expansion' }));
  });
  it('meters repeated empty producers across discarded images', () => {
    expect(() => runGraphics('10000 { 1 1 8 [1 0 0 1 0 0] { () } image } repeat',
      LoadLimits.defaults.with({ maxPostScriptOperations: 100000 })))
      .toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations', allowed: 100000 }));
  });
});
