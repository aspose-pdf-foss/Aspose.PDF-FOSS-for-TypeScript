import { describe, it, expect } from 'vitest';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
describe('PostScript budgets', () => {
  it('enforces exact cumulative boundaries and supports unlimited', () => {
    const b = new PsBudget(LoadLimits.defaults.with({maxPostScriptOperations: 2, maxPostScriptVmBytes: 2}));
    b.work(2); b.allocate(2);
    expect(() => b.work()).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
    expect(() => b.allocate(1)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
    const u = new PsBudget(LoadLimits.unlimited()); u.work(1e9); u.allocate(1e9);
  });
  it('does not charge trusted bootstrap and resumes accounting after errors', () => {
    const b = new PsBudget(LoadLimits.defaults.with({maxPostScriptOperations: 1}));
    expect(() => b.bootstrap(() => { b.work(100); throw new Error('x'); })).toThrow('x');
    b.work(); expect(() => b.work()).toThrow();
  });
});

it('refuses invalid charges instead of allowing them to refund the budget', () => {
  const budget = new PsBudget(LoadLimits.defaults.with({ maxPostScriptOperations: 1, maxPostScriptVmBytes: 1 }));
  for (const invalid of [-1, NaN, Infinity, 0.5]) {
    expect(() => budget.work(invalid)).toThrow(RangeError);
    expect(() => budget.allocate(invalid)).toThrow(RangeError);
  }
  budget.work(); budget.allocate(1);
  expect(() => budget.work()).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
  expect(() => budget.allocate(1)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
});

it('disables a single PostScript budget without disabling its neighbor', () => {
  const budget = new PsBudget(LoadLimits.defaults.with({ maxPostScriptOperations: null, maxPostScriptVmBytes: 1 }));
  budget.work(100_000_000); budget.allocate(1);
  expect(() => budget.allocate(1)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes', allowed: 1, reached: 2 }));
});
