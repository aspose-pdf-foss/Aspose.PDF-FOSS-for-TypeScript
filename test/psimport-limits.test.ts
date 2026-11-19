import { describe, expect, it } from 'vitest';
import { Document, LoadLimits, ResourceLimitError, type LimitField } from '../src/index.js';
import { runPostScriptImport } from '../src/psimport.js';
import { psBytes } from './helpers/ps-font-program.js';
import { epsSource, dosEps } from './helpers/build-eps.js';
import { PsInterpreter } from '../src/psvm.js';
import { framePostScript } from '../src/eps.js';
import { readEpsBox } from '../src/epsdsc.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { installPsText } from '../src/pstext.js';

function phaseCeiling(source: Uint8Array, field: 'maxPostScriptOperations' | 'maxPostScriptVmBytes'): number {
  const vm = new PsInterpreter(), framed = framePostScript(source, 'auto', vm.budget);
  readEpsBox(framed.source, vm.budget);
  // Calibrate execution independently of the public runner, so a missing DSC
  // charge in that runner cannot silently lower this test's expected ceiling.
  const executionVm = new PsInterpreter();
  const graphics = installPsGraphics(executionVm, { eps: true, box: [0,0,100,50], defaultMatrix: [1,0,0,1,10,-20] });
  installPsText(executionVm, graphics); executionVm.run(framed.source); graphics.finish();
  const remaining = (budget: typeof vm.budget) => field === 'maxPostScriptOperations' ? budget.remainingOperations : budget.remainingBytes;
  const preflight = LoadLimits.defaults[field]! - remaining(vm.budget);
  const execution = LoadLimits.defaults[field]! - remaining(executionVm.budget), whole = preflight + execution;
  // Each phase fits on its own. Only sharing one cumulative epoch refuses.
  const ceiling = Math.floor((whole + Math.max(preflight, execution)) / 2);
  expect(preflight).toBeLessThan(ceiling); expect(execution).toBeLessThan(ceiling); expect(whole).toBeGreaterThan(ceiling);
  return ceiling;
}

function refused(source: Uint8Array, limit: LimitField, allowed: number): ResourceLimitError {
  const doc = Document.New(); doc.loadLimits = LoadLimits.defaults.with({ [limit]: allowed });
  const bytes = doc.Save(), objects = [...doc.objectEntries()];
  let error: unknown;
  try { doc.AddPostScript(source); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ResourceLimitError);
  expect(error).toMatchObject({ limit, allowed });
  expect((error as ResourceLimitError).reached).toBeGreaterThan(allowed);
  expect(doc.Save()).toEqual(bytes); expect([...doc.objectEntries()]).toEqual(objects);
  return error as ResourceLimitError;
}
describe('public PostScript job limits', () => {
  it('bounds supplied font registration storage before constructing font programs', () => {
    const doc = Document.New(); doc.loadLimits = LoadLimits.defaults.with({ maxContainerItems: 256 });
    expect(() => doc.AddPostScript(new Uint8Array(), { fonts: Array.from({ length: 257 }, (_, i) =>
      ({ name: `font${i}`, bytes: new Uint8Array() })),
    })).toThrowError(expect.objectContaining({ limit: 'maxContainerItems', allowed: 256, reached: 257 }));
  });
  it('bounds the complete original wrapper before VM initialization', () => {
    const source = dosEps(epsSource(), new Uint8Array(1000));
    expect(refused(source, 'maxFileBytes', 100).reached).toBe(source.length);
  });
  it.each([
    ['maxPostScriptOperations', 100, 'showpage'],
    ['maxPostScriptVmBytes', 100, 'showpage'],
    ['maxContentBytes', 20, '0 0 1 1 rectfill showpage 0 0 1 1 rectfill'],
    ['maxContentTokens', 10, '0 0 1 1 rectfill'],
    ['maxObjects', 3, 'showpage showpage'],
    ['maxDecodedStreamBytes', 5, '10 1 8 [1 0 0 1 0 0] <00010203040506070809> image'],
  ] as const)('propagates %s and leaves the destination unchanged', (limit, allowed, source) => { refused(psBytes(source), limit, allowed); });
  it('shares DSC and VM operation totals instead of resetting at execution', () => {
    const small = epsSource('0 0 1 1 rectfill'), large = epsSource('%' + 'x'.repeat(3000) + '\n0 0 1 1 rectfill');
    const ceiling = phaseCeiling(large, 'maxPostScriptOperations');
    const doc = Document.New(); doc.loadLimits = LoadLimits.defaults.with({ maxPostScriptOperations: ceiling });
    expect(doc.AddPostScript(small).pages).toHaveLength(1);
    refused(large, 'maxPostScriptOperations', ceiling);
  });
  it('shares retained DSC metadata and glyph allocations in one epoch', () => {
    const source = epsSource('/Courier 10 selectfont -10 20 moveto (A) show', '%%BoundingBox: -10 20 90 70\n'.repeat(1000).trimEnd());
    refused(source, 'maxPostScriptVmBytes', phaseCeiling(source, 'maxPostScriptVmBytes'));
  });
  it('does not accumulate limits across separate imports', () => {
    const source = psBytes('showpage'), job = runPostScriptImport(source, {}, LoadLimits.defaults);
    const spent = LoadLimits.defaults.maxPostScriptOperations! - job.budget.remainingOperations;
    const doc = Document.New(); doc.loadLimits = LoadLimits.defaults.with({ maxPostScriptOperations: spent + 1000 });
    expect(doc.AddPostScript(source).pages).toHaveLength(1);
    expect(doc.AddPostScript(source).pages).toHaveLength(1);
  });
});
