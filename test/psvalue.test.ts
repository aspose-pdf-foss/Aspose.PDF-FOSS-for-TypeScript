import { describe, it, expect } from 'vitest';
import { integer, real, name, psEquals, withExecutable } from '../src/psvalue.js';
describe('PostScript values', () => {
  it('compares numeric values and preserves executable references', () => {
    expect(psEquals(integer(2), real(2))).toBe(true);
    expect(withExecutable(name('abc'), true)).toMatchObject({ kind: 'name', text: 'abc', executable: true });
  });
});

it('keeps numeric construction within the interpreter numeric model', () => {
  expect(() => integer(2147483648)).toThrowError(expect.objectContaining({ errorName: 'rangecheck' }));
  expect(() => integer(1.5)).toThrowError(expect.objectContaining({ errorName: 'rangecheck' }));
  expect(() => real(Infinity)).toThrowError(expect.objectContaining({ errorName: 'rangecheck' }));
});

it('compares byte strings by contents and composite views by identity and refuses reading restricted strings', async () => {
  const { PsMemory } = await import('../src/psmemory.js'); const { PsBudget } = await import('../src/psbudget.js');
  const m = new PsMemory(new PsBudget()); const bytes = m.string(new Uint8Array([0, 128, 255]));
  const other = m.string(new Uint8Array([0, 128, 255]));
  expect(psEquals(bytes, other)).toBe(true);
  expect(psEquals(bytes, name('\u0000\u0080\u00ff'))).toBe(true);
  expect(psEquals(m.interval(bytes, 1, 2), m.string(new Uint8Array([128, 255])))).toBe(true);
  const a = m.array(2); expect(psEquals(a, withExecutable(a, true))).toBe(true);
  expect(psEquals(a, m.array(2))).toBe(false);
  expect(psEquals(a, m.interval(a, 0, 1))).toBe(false);
  expect(() => psEquals(m.restrictAccess(bytes, 'noaccess'), other))
    .toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
});
