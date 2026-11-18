import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import { psNumberSequence } from '../src/psnumbers.js';
function values(hex: string) { const vm = new PsInterpreter(); return psNumberSequence(vm, vm.memory.string(Buffer.from(hex, 'hex'))); }
describe('PostScript encoded number sequences', () => {
  it.each(['95200002000a0014', '95a002000a001400'])('reads signed 16-bit numbers with the declared endian header: %s', hex => {
    const sequence = values(hex); expect(sequence.length).toBe(2); expect([sequence.get(0), sequence.get(1)]).toEqual([10, 20]);
  });
  it('reads fixed point 16/32-bit and IEEE32', () => {
    expect(values('95210002fffd0005').get(0)).toBe(-1.5);
    expect(values('9501000100000003').get(0)).toBe(1.5);
    expect(values('9530000141200000').get(0)).toBe(10);
  });
  it('defines native real as IEEE32 in native byte order', () => {
    const bytes = new Uint8Array(8); bytes.set([149, 49, 0, 1]); bytes.set(new Uint8Array(new Float32Array([12.5]).buffer), 4);
    const vm = new PsInterpreter(); expect(psNumberSequence(vm, vm.memory.string(bytes)).get(0)).toBe(12.5);
  });
  it('rejects short, malformed and nonfinite number strings', () => {
    expect(() => values('95200002000a')).toThrow(/rangecheck/);
    expect(() => values('953f0000')).toThrow(/typecheck/);
    expect(() => values('953000017f800000').get(0)).toThrow(/undefinedresult/);
  });
});
