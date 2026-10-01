// test/afdate.test.ts
import { describe, it, expect } from 'vitest';
import { DATE_FORMATS, TIME_FORMATS, dateFormat, dateKeystroke, scandStrict } from '../src/afdate.js';
import { loadGolden, goldenMeta } from './helpers/aform-goldens.js';

const fmtOf = (fn: string, a0: number | string): string | undefined =>
  fn.startsWith('AFTime') && typeof a0 === 'number' ? TIME_FORMATS[a0]
    : typeof a0 === 'number' ? DATE_FORMATS[a0] : a0;

describe('afdate against pdf.js', () => {
  it('the tables are pdf.js\'s, by size', () => {
    expect(DATE_FORMATS).toHaveLength(14);
    expect(TIME_FORMATS).toHaveLength(4);
  });

  it('formats every strictly matching golden case exactly as pdf.js', () => {
    const cases = loadGolden<{ fn: string; args: [number | string]; value: string; strict: boolean; out?: string }>('date-format');
    expect(cases.length).toBe(goldenMeta.counts['date-format']);
    const bad = cases.filter((c) => c.strict && dateFormat(c.value, fmtOf(c.fn, c.args[0])!) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('leaves every non-matching value unformatted (the stated divergence), and counts them', () => {
    const cases = loadGolden<{ fn: string; args: [number | string]; value: string; strict: boolean }>('date-format');
    const loose = cases.filter((c) => !c.strict);
    expect(loose.length).toBe(goldenMeta.strictFalse['date-format']);
    expect(loose.length).toBeGreaterThan(0);
    const bad = loose.filter((c) => dateFormat(c.value, fmtOf(c.fn, c.args[0])!) !== c.value);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('keystroke checks agree with pdf.js where it matched strictly, and reject the rest', () => {
    const cases = loadGolden<{ fn: string; args: [number | string]; value: string; strict: boolean; rc?: boolean }>('date-keystroke');
    expect(cases.length).toBe(goldenMeta.counts['date-keystroke']);
    expect(cases.filter((c) => !c.strict).length).toBe(goldenMeta.strictFalse['date-keystroke']);
    const bad = cases.filter((c) => {
      const fmt = fmtOf(c.fn, c.args[0]);
      if (fmt === undefined) return c.rc !== true;            // out-of-range index: pdf.js does nothing
      const ours = dateKeystroke(c.value, fmt);
      return c.strict ? ours !== c.rc : ours !== false;
    });
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('afdate never reads the machine time zone', () => {
  it('parses to fixed fields', () => {
    expect(scandStrict('yyyy-mm-dd HH:MM', '2024-02-29 13:05')).toEqual(
      { year: 2024, month: 1, day: 29, hours: 13, minutes: 5, seconds: 0, dayOfWeek: 4 });
  });

  it('makes a variable-width token possessive, as pdf.js does: HMM does not match 930', () => {
    // pdf.js wraps every \d{1,2} token as (?=(\d{1,2}))\N, so H takes "93"
    // and cannot give a digit back to MM.
    expect(scandStrict('HMM', '930')).toBeNull();
    expect(scandStrict('HMM', '0930')).not.toBeNull();
  });

  it('cannot be made to backtrack exponentially by a document-supplied picture', () => {
    const t0 = Date.now();
    // Without the lookahead this backtracks ~2.5x per token pair: measured 267 ms
    // at 26 tokens and 39 digits, so 32 tokens and 48 digits take seconds.
    expect(scandStrict('Hs'.repeat(16), `${'1'.repeat(48)}x`)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('reads yy as 20yy: 02/29/00 is a real day because 2000 is a leap year', () => {
    // yy PRINTS year % 100, so 1900+yy and 2000+yy agree on every golden; only
    // a day that exists in one century and not the other can tell them apart.
    expect(dateFormat('02/29/00', 'mm/dd/yy')).toBe('02/29/00');
  });

  it('normalises an overflowing day the way pdf.js\'s Date does', () => {
    expect(dateFormat('02/30/2024', 'mm/dd/yyyy')).toBe('03/01/2024');
  });
});
