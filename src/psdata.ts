import type { PsInterpreter } from './psvm.js';
import { PsFault, boolean, canRead, canWrite, integer, isComposite, isReference, mark, real, withExecutable, type PsArray, type PsComposite, type PsReference, type PsString, type PsValue } from './psvalue.js';

function composite(value: PsValue): PsComposite { if (!isComposite(value)) throw new PsFault('typecheck'); return value; }
function reference(value: PsValue): PsReference { if (!isReference(value)) throw new PsFault('typecheck'); return value; }
function sequence(value: PsValue): PsArray | PsString { if (value.kind !== 'array' && value.kind !== 'string') throw new PsFault('typecheck'); return value; }
function readable(value: PsComposite): void { if (!value.body.valid) throw new PsFault('invalidrestore'); if (!canRead(value)) throw new PsFault('invalidaccess'); }
function writable(value: PsComposite): void { if (!value.body.valid) throw new PsFault('invalidrestore'); if (!canWrite(value)) throw new PsFault('invalidaccess'); }
function numericText(value: Extract<PsValue, { kind: 'integer' | 'real' }>): string {
  const result = String(value.value); return value.kind === 'real' && !/[.e]/i.test(result) ? `${result}.0` : result;
}
function text(vm: PsInterpreter, value: PsString): string {
  readable(value); vm.budget.work(value.length); vm.budget.allocate(64 + value.length * 2, 'string text');
  let result = ''; for (let i = 0; i < value.length; i++) result += String.fromCharCode(value.body.bytes[value.offset + i]!); return result;
}
function writeText(vm: PsInterpreter, value: PsString, content: string): PsString {
  writable(value); if (content.length > value.length) throw new PsFault('rangecheck');
  vm.budget.work(content.length);
  for (let i = 0; i < content.length; i++) vm.memory.put(value, i, integer(content.charCodeAt(i)));
  return vm.memory.interval(value, 0, content.length);
}

export function installPsData(vm: PsInterpreter): void {
  const op = (key: string, fn: () => void): void => vm.registerOperator(key, fn);
  op('array', () => vm.replace(1, vm.memory.array(vm.typed('integer').value)));
  op('string', () => vm.replace(1, vm.memory.string(vm.typed('integer').value)));
  op('dict', () => vm.replace(1, vm.memory.dictionary(vm.typed('integer').value)));
  op('[', () => vm.push(mark())); op('<<', () => vm.push(mark()));
  op(']', () => { const n = vm.markDepth(), values = vm.slice(vm.stack.length - n); vm.replace(n + 1, vm.memory.arrayFrom(values)); });
  op('>>', () => {
    const n = vm.markDepth(); if (n % 2) throw new PsFault('rangecheck'); const dict = vm.memory.dictionary(n / 2);
    for (let i = n - 1; i > 0; i -= 2) { vm.budget.work(); vm.memory.put(dict, vm.peek(i), vm.peek(i - 1)); }
    vm.replace(n + 1, dict);
  });
  op('packedarray', () => {
    const n = vm.typed('integer').value; if (n < 0) throw new PsFault('rangecheck'); if (n > vm.stack.length - 1) throw new PsFault('stackunderflow');
    const values = vm.slice(vm.stack.length - 1 - n, vm.stack.length - 1); vm.replace(n + 1, vm.memory.arrayFrom(values, false, true));
  });
  op('setpacking', () => { vm.packing = vm.typed('boolean').value; vm.replace(1); });
  op('currentpacking', () => vm.push(boolean(vm.packing)));
  op('length', () => {
    const v = vm.peek(); let length: number;
    if (v.kind === 'name') length = v.text.length;
    else { const c = composite(v); readable(c); length = c.kind === 'dictionary' ? vm.memory.dictionarySize(c) : c.length; }
    vm.replace(1, integer(length));
  });
  op('get', () => vm.replace(2, vm.memory.get(composite(vm.peek(1)), vm.peek())));
  op('put', () => { vm.memory.put(composite(vm.peek(2)), vm.peek(1), vm.peek()); vm.replace(3); });
  op('getinterval', () => vm.replace(3, vm.memory.interval(sequence(vm.peek(2)), vm.typed('integer', 1).value, vm.typed('integer').value)));
  op('putinterval', () => {
    const source = sequence(vm.peek()), index = vm.typed('integer', 1).value, target = sequence(vm.peek(2));
    if (source.kind !== target.kind) throw new PsFault('typecheck');
    vm.memory.copy(source, vm.memory.interval(target, index, source.length)); vm.replace(3);
  });
  op('aload', () => {
    const value = vm.typed('array'); readable(value); vm.budget.items(vm.stack.length + value.length); vm.budget.work(value.length);
    vm.replace(1); for (let i = 0; i < value.length; i++) vm.push(vm.memory.get(value, i)); vm.push(value);
  });
  op('astore', () => {
    const value = vm.typed('array'); writable(value); if (value.length > vm.stack.length - 1) throw new PsFault('stackunderflow');
    vm.budget.work(value.length);
    for (let i = 0; i < value.length; i++) vm.memory.put(value, i, vm.peek(value.length - i));
    vm.replace(value.length + 1, value);
  });
  op('copy', () => {
    if (vm.peek().kind === 'gstate') {
      const target = vm.typed('gstate'), source = vm.typed('gstate', 1);
      vm.memory.writeGState(target, vm.memory.readGState(source));
      vm.replace(2, target);
      return;
    }
    const target = vm.peek();
    if (target.kind === 'integer') {
      const n = target.value; if (n < 0) throw new PsFault('rangecheck'); if (n > vm.stack.length - 1) throw new PsFault('stackunderflow');
      vm.budget.items(vm.stack.length - 1 + n);
      const values = vm.slice(vm.stack.length - 1 - n, vm.stack.length - 1); vm.replace(1); for (const value of values) vm.push(value);
    } else vm.replace(2, vm.memory.copy(composite(vm.peek(1)), composite(target)));
  });
  for (const key of ['search', 'anchorsearch']) op(key, () => {
    const seek = vm.typed('string'), value = vm.typed('string', 1); readable(value); readable(seek); let found = -1;
    const last = key === 'anchorsearch' ? Math.min(0, value.length - seek.length) : value.length - seek.length;
    for (let i = 0; i <= last; i++) {
      vm.budget.work(); let j = 0;
      for (; j < seek.length; j++) { vm.budget.work(); if (value.body.bytes[value.offset + i + j] !== seek.body.bytes[seek.offset + j]) break; }
      if (j === seek.length) { found = i; break; }
    }
    if (found < 0) { vm.replace(2, value, boolean(false)); return; }
    const after = vm.memory.interval(value, found + seek.length, value.length - found - seek.length), match = vm.memory.interval(value, found, seek.length);
    if (key === 'search') vm.replace(2, after, match, vm.memory.interval(value, 0, found), boolean(true));
    else vm.replace(2, after, match, boolean(true));
  });
  op('token', () => {
    const value = vm.typed('string'); readable(value); const scanner = vm.scanner(vm.memory.executionBytes(value)); const next = scanner.next();
    if (!next) vm.replace(1, boolean(false));
    else vm.replace(1, vm.memory.interval(value, scanner.position, value.length - scanner.position), next, boolean(true));
  });
  op('begin', () => { vm.begin(vm.typed('dictionary')); vm.replace(1); }); op('end', () => vm.end());
  op('def', () => { vm.memory.put(vm.currentdict, vm.peek(1), vm.peek()); vm.replace(2); });
  op('store', () => { const key = vm.peek(1); vm.memory.put(vm.where(key) ?? vm.currentdict, key, vm.peek()); vm.replace(2); });
  op('load', () => { const key = vm.peek(), dict = vm.where(key); if (!dict) throw new PsFault('undefined'); vm.replace(1, vm.memory.get(dict, key)); });
  op('known', () => vm.replace(2, boolean(vm.memory.lookup(vm.typed('dictionary', 1), vm.peek()) !== undefined)));
  op('where', () => { const dict = vm.where(vm.peek()); if (dict) vm.replace(1, dict, boolean(true)); else vm.replace(1, boolean(false)); });
  op('undef', () => { vm.memory.remove(vm.typed('dictionary', 1), vm.peek()); vm.replace(2); });
  op('maxlength', () => { const dict = vm.typed('dictionary'); readable(dict); vm.replace(1, integer(dict.body.capacity)); });
  op('currentdict', () => vm.push(vm.currentdict));
  op('countdictstack', () => vm.push(integer(vm.dictionaryStack.length)));
  op('dictstack', () => {
    const array = vm.typed('array'); writable(array); if (array.length < vm.dictionaryStack.length) throw new PsFault('rangecheck');
    vm.budget.work(vm.dictionaryStack.length); for (let i = 0; i < vm.dictionaryStack.length; i++) vm.memory.put(array, i, vm.dictionaryStack[i]!);
    vm.replace(1, vm.memory.interval(array, 0, vm.dictionaryStack.length));
  });
  op('cleardictstack', () => vm.clearDictionaries());
  op('cvlit', () => vm.replace(1, withExecutable(vm.peek(), false)));
  op('cvx', () => vm.replace(1, withExecutable(vm.peek(), true)));
  op('xcheck', () => vm.replace(1, boolean(vm.peek().executable)));
  for (const key of ['cvi', 'cvr']) op(key, () => {
    let value = vm.peek();
    if (value.kind === 'string') {
      readable(value); const scanner = vm.scanner(vm.memory.executionBytes(value)), first = scanner.next();
      if (!first) throw new PsFault('syntaxerror'); value = first;
    }
    if (value.kind !== 'integer' && value.kind !== 'real') throw new PsFault('typecheck');
    vm.replace(1, key === 'cvi' ? integer(Math.trunc(value.value)) : real(value.value));
  });
  op('cvn', () => { const value = vm.typed('string'); vm.replace(1, vm.memory.name(text(vm, value), value.executable)); });
  op('cvs', () => {
    const dest = vm.typed('string'), value = vm.peek(1); let result: string;
    if (value.kind === 'string') result = text(vm, value);
    else if (value.kind === 'name') result = value.text;
    else if (value.kind === 'operator') result = value.name;
    else if (value.kind === 'integer' || value.kind === 'real') result = numericText(value);
    else if (value.kind === 'boolean') result = String(value.value);
    else result = '--nostringval--';
    vm.budget.allocate(64 + result.length * 2, 'conversion text'); vm.replace(2, writeText(vm, dest, result));
  });
  op('cvrs', () => {
    const dest = vm.typed('string'), radix = vm.typed('integer', 1).value, value = vm.number(2);
    if (radix < 2 || radix > 36) throw new PsFault('rangecheck');
    const result = radix === 10 ? numericText(value) : (integer(Math.trunc(value.value)).value >>> 0).toString(radix).toUpperCase();
    vm.budget.allocate(64 + result.length * 2, 'conversion text'); vm.replace(3, writeText(vm, dest, result));
  });
  for (const key of ['readonly', 'executeonly', 'noaccess'] as const) op(key, () => vm.replace(1, vm.memory.restrictAccess(reference(vm.peek()), key)));
  for (const key of ['rcheck', 'wcheck']) op(key, () => {
    const value = reference(vm.peek()); if (!value.body.valid) throw new PsFault('invalidrestore'); vm.replace(1, boolean(key === 'rcheck' ? canRead(value) : canWrite(value)));
  });
  op('setglobal', () => { vm.memory.currentGlobal = vm.typed('boolean').value; vm.replace(1); });
  op('currentglobal', () => vm.push(boolean(vm.memory.currentGlobal)));
  op('gcheck', () => { const value = vm.peek(); vm.replace(1, boolean(isReference(value) ? value.body.global : value.kind !== 'save')); });
  op('save', () => vm.push(vm.save()));
  op('restore', () => { const token = vm.typed('save'); vm.replace(1); vm.restore(token); });
}
