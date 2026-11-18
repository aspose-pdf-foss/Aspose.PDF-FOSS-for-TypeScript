import type { PsInterpreter } from './psvm.js';
import { canRead, PsFault, type PsArray, type PsString } from './psvalue.js';
export function psNumberSequence(vm: PsInterpreter, value: PsArray | PsString): { length: number; get(index: number): number } {
  if (!value.body.valid) throw new PsFault('invalidrestore'); if (!canRead(value)) throw new PsFault('invalidaccess');
  vm.budget.allocate(96, 'text number sequence');
  if (value.kind === 'array') return { length: value.length, get: index => {
    vm.budget.work(); const item = vm.memory.get(value, index); if (item.kind !== 'real' && item.kind !== 'integer') throw new PsFault('typecheck');
    if (!Number.isFinite(item.value)) throw new PsFault('undefinedresult'); return item.value;
  } };
  if (value.length < 4) throw new PsFault('rangecheck');
  const byte = (i: number): number => { const v = vm.memory.get(value, i); return v.kind === 'integer' ? v.value : 0; };
  if (byte(0) !== 149) throw new PsFault('typecheck');
  const format = byte(1), little = !!(format & 128), representation = format & 127;
  if (representation > 49) throw new PsFault('typecheck');
  const length = little ? byte(2) + byte(3) * 256 : byte(2) * 256 + byte(3);
  const width = representation >= 32 && representation < 48 ? 2 : 4;
  if (value.length !== 4 + length * width) throw new PsFault('rangecheck');
  vm.budget.items(length, 'encoded numbers');
  const nativeLittle = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  return { length, get: index => {
    if (!Number.isInteger(index) || index < 0 || index >= length) throw new PsFault('rangecheck');
    if (!value.body.valid) throw new PsFault('invalidrestore'); if (!canRead(value)) throw new PsFault('invalidaccess');
    vm.budget.work(width, 'encoded number'); vm.budget.allocate(32, 'encoded number view');
    const view = new DataView(value.body.bytes.buffer, value.body.bytes.byteOffset + value.offset + 4 + index * width, width);
    const n = representation < 32 ? view.getInt32(0, little) / 2 ** representation
      : representation < 48 ? view.getInt16(0, little) / 2 ** (representation - 32)
        : view.getFloat32(0, representation === 49 ? nativeLittle : little);
    if (!Number.isFinite(n)) throw new PsFault('undefinedresult'); return n;
  } };
}
