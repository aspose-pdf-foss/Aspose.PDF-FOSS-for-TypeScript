// test/afcalc.test.ts
import { describe, it, expect } from 'vitest';
import { exactSum, simpleCalculate, rangeValidate } from '../src/afcalc.js';
import { loadGolden, goldenMeta } from './helpers/aform-goldens.js';

describe('afcalc against pdf.js', () => {
  it('AFSimple_Calculate matches every golden case, as the string a field stores', () => {
    const cases = loadGolden<{ op: string; values: string[]; out: number }>('simple-calculate');
    expect(cases.length).toBe(goldenMeta.counts['simple-calculate']);
    const bad = cases.filter((c) => String(simpleCalculate(c.op, c.values)) !== String(c.out));
    expect(bad).toEqual([]);
  });

  it('AFRange_Validate matches every golden case', () => {
    const cases = loadGolden<{ args: [boolean, number, boolean, number]; value: string; rc: boolean }>('range-validate');
    expect(cases.length).toBe(goldenMeta.counts['range-validate']);
    const bad = cases.filter((c) => rangeValidate(c.value, ...c.args) !== c.rc);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('exactSum', () => {
  it('is exactly rounded where naive addition is not', () => {
    expect(exactSum([1e16, 1, -1e16])).toBe(1);
    expect(exactSum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(exactSum([])).toBe(0);
  });
});

it('an unknown operation is unrecognised', () => {
  expect(simpleCalculate('MEDIAN', ['1'])).toBeUndefined();
});
