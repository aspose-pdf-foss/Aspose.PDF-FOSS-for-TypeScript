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

describe('PostScript budget reservations', () => {
  const limits = LoadLimits.defaults.with({ maxPostScriptVmBytes: 128, maxPostScriptOperations: 32 });

  it('holds capacity and commits only the actual cost', () => {
    const budget = new PsBudget(limits);
    const reservation = budget.reserve(64, 8);
    expect(budget.remainingBytes).toBe(64);
    expect(budget.remainingOperations).toBe(24);
    expect(() => budget.allocate(65)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes', reached: 129 }));
    reservation.commit(16, 2);
    expect(budget.remainingBytes).toBe(112);
    expect(budget.remainingOperations).toBe(30);
    budget.allocate(112);
    expect(() => budget.allocate(1)).toThrow();
    expect(() => reservation.commit(0, 0)).toThrow(RangeError);
  });

  it('releases unused capacity once without refunding committed work', () => {
    const budget = new PsBudget(limits);
    budget.work(3);
    const outer = budget.reserve(64, 8);
    const inner = budget.reserve(64, 8);
    expect(budget.remainingBytes).toBe(0);
    inner.cancel();
    outer.commit(16, 2);
    expect(budget.remainingBytes).toBe(112);
    expect(budget.remainingOperations).toBe(27);
    expect(() => inner.cancel()).toThrow(RangeError);
  });

  it('refuses invalid and overcommitted costs without losing the reservation', () => {
    const budget = new PsBudget(limits);
    for (const count of [-1, 0.5, NaN, Infinity]) {
      expect(() => budget.reserve(count, 0)).toThrow(RangeError);
      expect(() => budget.reserve(0, count)).toThrow(RangeError);
    }
    const reservation = budget.reserve(8, 8);
    expect(() => reservation.commit(9, 0)).toThrow(RangeError);
    expect(() => reservation.commit(0, 9)).toThrow(RangeError);
    reservation.cancel();
    expect(budget.remainingBytes).toBe(128);
  });

  it('refuses a reservation atomically against both limits', () => {
    const budget = new PsBudget(limits);
    expect(() => budget.reserve(64, 33)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
    expect(budget.remainingBytes).toBe(128);
    expect(budget.remainingOperations).toBe(32);
    const unlimited = new PsBudget(LoadLimits.unlimited());
    expect(unlimited.remainingBytes).toBe(Infinity);
    const reservation = unlimited.reserve(1000, 1000);
    reservation.commit(10, 10);
    expect(unlimited.remainingOperations).toBe(Infinity);
  });
});
