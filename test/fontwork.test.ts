import { describe, expect, it } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { Type1Font } from '../src/type1.js';
import { runType1Charstring } from '../src/type1charstring.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError } from '../src/errors.js';
import { buildCompositeTtf, buildMinimalTtf } from './helpers/build-sfnt.js';
import { buildType1, t1cs, t1num } from './helpers/build-type1.js';

const glyph = t1cs(t1num(0), t1num(500), 13, 14);
describe('job-accounted strict font parsers', () => {
  it.each(['maxPostScriptVmBytes', 'maxPostScriptOperations'] as const)('bounds sfnt parsing before growth with %s', key => {
    const work = new PsBudget(LoadLimits.defaults.with({ [key]: 1 }));
    expect(() => parseSfnt(buildMinimalTtf(), 0, work.limits, { work, strict: true }))
      .toThrowError(expect.objectContaining({ limit: key }));
  });
  it('bounds table counts before creating their map', () => {
    const work = new PsBudget(LoadLimits.defaults.with({ maxContainerItems: 9 }));
    expect(() => parseSfnt(buildMinimalTtf(), 0, work.limits, { work, strict: true }))
      .toThrowError(expect.objectContaining({ limit: 'maxContainerItems', reached: 10 }));
  });
  it('rejects malformed glyph data only on the strict path', () => {
    const bytes = buildMinimalTtf();
    expect(parseSfnt(bytes).glyphOutline(1)).toEqual([]);
    expect(() => parseSfnt(bytes, 0, LoadLimits.defaults, { strict: true }).glyphOutline(1)).toThrow(PdfParseError);
  });
  it.each(['maxPostScriptVmBytes', 'maxPostScriptOperations'] as const)('bounds Type 1 parsing before growth with %s', key => {
    const work = new PsBudget(LoadLimits.defaults.with({ [key]: 1 }));
    expect(() => new Type1Font(buildType1({ charstrings: { A: glyph } }), work.limits, { work, strict: true }))
      .toThrowError(expect.objectContaining({ limit: key }));
  });
  it('accounts charstring operands as well as drawing operators', () => {
    const work = new PsBudget(LoadLimits.defaults.with({ maxPostScriptOperations: 3 }));
    expect(() => runType1Charstring(t1cs(...new Array(20).fill(t1num(0))), { subrs: [], work, strict: true }))
      .toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
  });
  it('preserves sbw y advance', () => {
    const bytes = buildType1({ charstrings: { A: t1cs(t1num(10), t1num(20), t1num(500), t1num(30), 12, 7, 14) } });
    const font = new Type1Font(bytes, LoadLimits.defaults, { work: new PsBudget(), strict: true });
    expect(font.glyphAdvance(0)).toEqual([500, 30]);
  });
  it('rejects unknown charstring operators and truncated operands in strict mode', () => {
    expect(() => runType1Charstring(new Uint8Array([255, 0]), { subrs: [], strict: true })).toThrow(PdfParseError);
    expect(() => runType1Charstring(new Uint8Array([2]), { subrs: [], strict: true })).toThrow(PdfParseError);
  });
  it('rejects missing endchar and malformed standard flex instead of an apparently empty glyph', () => {
    expect(() => runType1Charstring(t1cs(t1num(0), t1num(500), 13), { subrs: [], strict: true })).toThrow(PdfParseError);
    expect(() => runType1Charstring(t1cs(t1num(0), t1num(500), 13, t1num(0), t1num(0), 12, 16, 14), { subrs: [], strict: true })).toThrow(PdfParseError);
  });
  it('charges composite expansion before allocating transformed points', () => {
    const bytes = buildCompositeTtf(), work = new PsBudget();
    const font = parseSfnt(bytes, 0, work.limits, { work, strict: true });
    const start = work.remainingBytes; font.glyphOutline(2);
    const used = start - work.remainingBytes;
    expect(used).toBeGreaterThan(0);
    const limited = new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: used - 1 }));
    const another = parseSfnt(bytes, 0, limited.limits, { strict: true }); another.work = limited;
    expect(() => another.glyphOutline(2)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
  });
  it('accounts warm and cold bundled parses identically', () => {
    const first = new PsBudget(), second = new PsBudget();
    getStd14Sfnt('Courier');
    const a = getStd14Sfnt('Courier', { work: first }), b = getStd14Sfnt('Courier', { work: second });
    expect(a).toBeDefined(); expect(b).not.toBe(a);
    expect(first.remainingBytes).toBeLessThan(first.limits.maxPostScriptVmBytes!);
    expect(first.remainingOperations).toBeLessThan(first.limits.maxPostScriptOperations!);
    expect([first.remainingBytes, first.remainingOperations]).toEqual([second.remainingBytes, second.remainingOperations]);
  });
});
