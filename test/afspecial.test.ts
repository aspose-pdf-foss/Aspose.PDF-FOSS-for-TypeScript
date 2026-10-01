// test/afspecial.test.ts
import { describe, it, expect } from 'vitest';
import { specialFormat, specialKeystroke, specialKeystrokeEx, printx } from '../src/afspecial.js';
import { loadGolden, goldenMeta } from './helpers/aform-goldens.js';

describe('afspecial against pdf.js', () => {
  it('AFSpecial_Format matches every golden case', () => {
    const cases = loadGolden<{ psf: number; value: string; out: string }>('special-format');
    expect(cases.length).toBe(goldenMeta.counts['special-format']);
    const bad = cases.filter((c) => specialFormat(c.value, c.psf) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('the special keystroke checks match every golden case', () => {
    const cases = loadGolden<{ fn: string; args: [number | string]; value: string; rc: boolean }>('special-keystroke');
    expect(cases.length).toBe(goldenMeta.counts['special-keystroke']);
    const bad = cases.filter((c) => (c.fn === 'AFSpecial_Keystroke'
      ? specialKeystroke(c.value, c.args[0] as number)
      : specialKeystrokeEx(c.value, c.args[0] as string)) !== c.rc);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('afspecial edges', () => {
  it('printx honours case shifts and escapes', () => {
    expect(printx('>AAA<AAA', 'abcDEF')).toBe('ABCdef');
    expect(printx('\\9-999', '123')).toBe('9-123');
  });

  it('an unknown psf with a value is unrecognised; with no value it is a no-op', () => {
    expect(specialFormat('123', 4)).toBeUndefined();
    expect(specialFormat('', 4)).toBe('');
    expect(specialKeystroke('123', 4)).toBeUndefined();
  });
});
