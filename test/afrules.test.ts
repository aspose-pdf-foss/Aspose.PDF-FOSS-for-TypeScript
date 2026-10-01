// test/afrules.test.ts
import { describe, it, expect } from 'vitest';
import { formatValue, checkValue, evaluateRules } from '../src/afrules.js';
import { loadGolden } from './helpers/aform-goldens.js';

const lit = (a: unknown): string => JSON.stringify(a);
const scriptOf = (fn: string, args: readonly unknown[]): string => `${fn}(${args.map(lit).join(', ')});`;

describe('the goldens hold through the real recognition path', () => {
  it('AFNumber_Format scripts', () => {
    const cases = loadGolden<{ args: unknown[]; value: string; out: string }>('number-format');
    const bad = cases.filter((c) => formatValue(scriptOf('AFNumber_Format', c.args), c.value) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('strict date scripts, index and picture forms', () => {
    const cases = loadGolden<{ fn: string; args: unknown[]; value: string; strict: boolean; out?: string }>('date-format');
    const bad = cases.filter((c) => c.strict && formatValue(scriptOf(c.fn, c.args), c.value) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('range validate scripts', () => {
    const cases = loadGolden<{ args: unknown[]; value: string; rc: boolean }>('range-validate');
    const bad = cases.filter((c) => checkValue('validate', scriptOf('AFRange_Validate', c.args), c.value)?.ok !== c.rc);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('slots', () => {
  it('a keystroke function in the format slot is not a format', () => {
    expect(formatValue('AFNumber_Keystroke(2,0,0,0,"",true)', '1')).toBeUndefined();
  });

  it('a validate function in the keystroke slot is not a keystroke check', () => {
    expect(checkValue('keystroke', 'AFRange_Validate(true,0,true,1)', '5')).toBeUndefined();
  });

  it('a keystroke function in the validate slot is not a validate check', () => {
    expect(checkValue('validate', 'AFNumber_Keystroke(2,0,0,0,"",true)', 'abc')).toBeUndefined();
  });

  it('an out-of-range date index is not a format, and is a no-op keystroke check', () => {
    expect(formatValue('AFDate_Format(99)', '03/04/24')).toBeUndefined();
    expect(checkValue('keystroke', 'AFDate_Keystroke(99)', 'garbage')).toEqual({ ok: true, rule: 'AFDate_Keystroke' });
  });
});

describe('evaluateRules', () => {
  const actions = {
    keystroke: { type: 'javascript' as const, script: 'AFNumber_Keystroke(2, 0, 0, 0, "", true);' },
    validate: { type: 'javascript' as const, script: 'AFRange_Validate(true, 0, true, 100);' },
  };

  it('rejects by each trigger that rejects', () => {
    expect(evaluateRules('amt', actions, '150').rejected).toEqual([
      { field: 'amt', trigger: 'validate', rule: 'AFRange_Validate', value: '150', message: 'AFRange_Validate rejected "150"' },
    ]);
    expect(evaluateRules('amt', actions, 'abc').rejected.map((r) => r.trigger)).toEqual(['keystroke']);
  });

  it('passes an empty value', () => {
    expect(evaluateRules('amt', actions, '')).toEqual({ rejected: [], unrecognised: [] });
  });

  it('reports a custom script as unrecognised, never as a pass or a rejection', () => {
    const custom = { validate: { type: 'javascript' as const, script: 'if (event.value > 3) event.rc = false;' } };
    expect(evaluateRules('amt', custom, '9')).toEqual({
      rejected: [],
      unrecognised: [{ field: 'amt', trigger: 'validate', script: custom.validate.script }],
    });
  });
});
