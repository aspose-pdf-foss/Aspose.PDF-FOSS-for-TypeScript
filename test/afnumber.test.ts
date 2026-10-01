// test/afnumber.test.ts
import { describe, it, expect } from 'vitest';
import { makeNumber, numberFormat, numberKeystroke, percentFormat } from '../src/afnumber.js';
import { loadGolden, goldenMeta } from './helpers/aform-goldens.js';

type NumArgs = [number, number, number, number, string, boolean];

describe('afnumber against pdf.js', () => {
  it('AFNumber_Format matches every golden case', () => {
    const cases = loadGolden<{ args: NumArgs; value: string; out: string }>('number-format');
    expect(cases.length).toBe(goldenMeta.counts['number-format']);
    expect(cases.length).toBeGreaterThan(9000);
    const bad = cases.filter((c) => numberFormat(c.value, ...c.args) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('AFPercent_Format matches every golden case', () => {
    const cases = loadGolden<{ args: [number, number, boolean]; value: string; out: string }>('percent-format');
    expect(cases.length).toBe(goldenMeta.counts['percent-format']);
    const bad = cases.filter((c) => percentFormat(c.value, ...c.args) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('the number and percent keystroke checks match every golden case', () => {
    const cases = loadGolden<{ fn: string; args: number[]; value: string; rc: boolean }>('number-keystroke');
    expect(cases.length).toBe(goldenMeta.counts['number-keystroke']);
    const bad = cases.filter((c) => numberKeystroke(c.value, c.args[1]) !== c.rc);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('afnumber edges pdf.js defines and a reader would not guess', () => {
  it('makeNumber reads a comma as the decimal point, so 1,234.5 is 1.234', () => {
    expect(makeNumber('1,234.5')).toBe(1.234);
    expect(makeNumber(' 1,5 ')).toBe(1.5);
    expect(makeNumber('abc')).toBeNull();
    expect(makeNumber('1e400')).toBeNull();
  });

  it('refuses arguments pdf.js would throw on', () => {
    expect(numberFormat('1', -1, 0, 0, 0, '', true)).toBeUndefined();
    expect(numberFormat('1', 1.5, 0, 0, 0, '', true)).toBeUndefined();
    expect(numberFormat('1', 2, 0, 0, 0, '%', true)).toBeUndefined();
    expect(percentFormat('1', -1, 0)).toBeUndefined();
    expect(percentFormat('1', 200, 0)).toBeUndefined();
  });

  it('formats a currency outside ASCII verbatim', () => {
    expect(numberFormat('1234.5', 2, 2, 0, 0, ' €', false)).toBe('1.234,50 €');
  });
});
