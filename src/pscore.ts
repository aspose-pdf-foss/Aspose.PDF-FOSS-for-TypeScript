import type { PsInterpreter } from './psvm.js';
import { PsFault, boolean, canRead, canWrite, integer, isComposite, mark, name, psEquals, real, type PsArray, type PsValue } from './psvalue.js';

function numeric(value: number, integral: boolean): PsValue {
  if (!Number.isFinite(value)) throw new PsFault('undefinedresult');
  return integral && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? integer(value) : real(value);
}

export function installPsCore(vm: PsInterpreter): void {
  const op = (text: string, fn: () => void): void => vm.registerOperator(text, fn);
  op('pop', () => vm.replace(1));
  op('exch', () => { const b = vm.peek(), a = vm.peek(1); vm.replace(2, b, a); });
  op('dup', () => vm.push(vm.peek()));
  op('index', () => { const n = vm.typed('integer').value; if (n < 0) throw new PsFault('rangecheck'); vm.replace(1, vm.peek(n + 1)); });
  op('roll', () => {
    const j = vm.typed('integer').value, n = vm.typed('integer', 1).value;
    if (n < 0) throw new PsFault('rangecheck'); if (n > vm.stack.length - 2) throw new PsFault('stackunderflow');
    const values = vm.slice(vm.stack.length - 2 - n, vm.stack.length - 2);
    const shift = n ? ((j % n) + n) % n : 0;
    vm.replace(2 + n); for (let i = 0; i < n; i++) vm.push(values[(i + n - shift) % n]!);
  });
  op('copy', () => {
    const n = vm.typed('integer').value; if (n < 0) throw new PsFault('rangecheck');
    if (n > vm.stack.length - 1) throw new PsFault('stackunderflow');
    const values = vm.slice(vm.stack.length - 1 - n, vm.stack.length - 1);
    vm.replace(1); for (const value of values) vm.push(value);
  });
  op('clear', () => vm.replace(vm.stack.length));
  op('count', () => vm.push(integer(vm.stack.length)));
  op('mark', () => vm.push(mark()));
  op('cleartomark', () => vm.replace(vm.markDepth() + 1));
  op('counttomark', () => vm.push(integer(vm.markDepth())));
  op('type', () => { const v = vm.peek(); vm.replace(1, name(v.kind === 'dictionary' ? 'dicttype' : v.kind === 'fontid' ? 'fonttype' : v.kind === 'array' && v.body.packed ? 'packedarraytype' : `${v.kind}type`)); });
  for (const [text, fn] of Object.entries({ add: (a: number, b: number) => a + b, sub: (a: number, b: number) => a - b, mul: (a: number, b: number) => a * b })) {
    op(text, () => { const b = vm.number(), a = vm.number(1); vm.replace(2, numeric(fn(a.value, b.value), a.kind === 'integer' && b.kind === 'integer')); });
  }
  op('div', () => { const b = vm.number().value, a = vm.number(1).value; if (b === 0) throw new PsFault('undefinedresult'); vm.replace(2, numeric(a / b, false)); });
  for (const text of ['idiv', 'mod']) op(text, () => {
    const b = vm.typed('integer').value, a = vm.typed('integer', 1).value;
    if (b === 0) throw new PsFault('undefinedresult');
    const result = text === 'mod' ? a % b : Math.trunc(a / b);
    if (result > 2147483647) throw new PsFault('undefinedresult'); vm.replace(2, integer(result));
  });
  for (const [text, fn] of Object.entries({ neg: (a: number) => -a, abs: Math.abs, ceiling: Math.ceil, floor: Math.floor, round: Math.round, truncate: Math.trunc })) {
    op(text, () => { const value = vm.number(); vm.replace(1, numeric(fn(value.value), value.kind === 'integer')); });
  }
  for (const [text, fn] of Object.entries({ sqrt: Math.sqrt, ln: Math.log, log: Math.log10, sin: (a: number) => Math.sin(a * Math.PI / 180), cos: (a: number) => Math.cos(a * Math.PI / 180) })) {
    op(text, () => vm.replace(1, numeric(fn(vm.number().value), false)));
  }
  op('exp', () => { const b = vm.number().value, a = vm.number(1).value; vm.replace(2, numeric(a ** b, false)); });
  op('atan', () => {
    const den = vm.number().value, num = vm.number(1).value; if (!den && !num) throw new PsFault('undefinedresult');
    const angle = Math.atan2(num, den) * 180 / Math.PI; vm.replace(2, real(angle < 0 ? angle + 360 : angle));
  });
  let seed = 1;
  op('srand', () => { seed = vm.typed('integer').value >>> 0; vm.replace(1); });
  op('rrand', () => vm.push(integer(seed | 0)));
  op('rand', () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; vm.push(integer(seed >>> 1)); });
  op('bitshift', () => {
    const shift = vm.typed('integer').value, value = vm.typed('integer', 1).value;
    vm.replace(2, integer(Math.abs(shift) >= 32 ? 0 : shift < 0 ? value >>> -shift : value << shift));
  });
  for (const text of ['and', 'or', 'xor']) op(text, () => {
    const b = vm.peek(), a = vm.peek(1);
    if (a.kind === 'boolean' && b.kind === 'boolean') vm.replace(2, boolean(text === 'and' ? a.value && b.value : text === 'or' ? a.value || b.value : a.value !== b.value));
    else if (a.kind === 'integer' && b.kind === 'integer') vm.replace(2, integer(text === 'and' ? a.value & b.value : text === 'or' ? a.value | b.value : a.value ^ b.value));
    else throw new PsFault('typecheck');
  });
  op('not', () => { const v = vm.peek(); if (v.kind === 'boolean') vm.replace(1, boolean(!v.value)); else if (v.kind === 'integer') vm.replace(1, integer(~v.value)); else throw new PsFault('typecheck'); });
  for (const text of ['eq', 'ne']) op(text, () => { const equal = psEquals(vm.peek(1), vm.peek(), count => vm.budget.work(count)); vm.replace(2, boolean(text === 'eq' ? equal : !equal)); });
  for (const text of ['gt', 'ge', 'lt', 'le']) op(text, () => {
    const b = vm.peek(), a = vm.peek(1); let comparison: number;
    if ((a.kind === 'integer' || a.kind === 'real') && (b.kind === 'integer' || b.kind === 'real')) comparison = a.value - b.value;
    else if (a.kind === 'string' && b.kind === 'string') {
      vm.memory.interval(a, 0, 0); vm.memory.interval(b, 0, 0); comparison = a.length - b.length;
      for (let i = 0; i < Math.min(a.length, b.length); i++) { vm.budget.work(); const delta = a.body.bytes[a.offset + i]! - b.body.bytes[b.offset + i]!; if (delta) { comparison = delta; break; } }
    } else throw new PsFault('typecheck');
    vm.replace(2, boolean(text === 'gt' ? comparison > 0 : text === 'ge' ? comparison >= 0 : text === 'lt' ? comparison < 0 : comparison <= 0));
  });
  op('exec', () => {
    const value = vm.peek();
    if (value.executable && (value.kind === 'array' || value.kind === 'string')) vm.memory.checkExecutable(value);
    vm.replace(1); vm.execute(value);
  });
  op('if', () => { const proc = vm.procedure(), condition = vm.typed('boolean', 1).value; vm.replace(2); if (condition) vm.execute(proc); });
  op('ifelse', () => { const no = vm.procedure(), yes = vm.procedure(1), condition = vm.typed('boolean', 2).value; vm.replace(3); vm.execute(condition ? yes : no); });
  op('for', () => {
    const proc = vm.procedure(), limit = vm.number(1), increment = vm.number(2), initial = vm.number(3);
    let current = initial.value; const integral = initial.kind === 'integer' && increment.kind === 'integer';
    vm.replace(4);
    vm.scheduleLoop(() => {
      if (increment.value >= 0 ? current > limit.value : current < limit.value) return false;
      vm.push(numeric(current, integral)); current += increment.value; vm.execute(proc); return true;
    }, [proc]);
  });
  op('repeat', () => {
    const proc = vm.procedure(); let remaining = vm.typed('integer', 1).value; if (remaining < 0) throw new PsFault('rangecheck'); vm.replace(2);
    vm.scheduleLoop(() => { if (remaining-- <= 0) return false; vm.execute(proc); return true; }, [proc]);
  });
  op('loop', () => { const proc = vm.procedure(); vm.replace(1); vm.scheduleLoop(() => { vm.execute(proc); return true; }, [proc]); });
  op('forall', () => {
    const proc = vm.procedure(), value = vm.peek(1); if (!isComposite(value)) throw new PsFault('typecheck');
    if (!value.body.valid) throw new PsFault('invalidrestore'); if (!canRead(value)) throw new PsFault('invalidaccess');
    const entries = value.kind === 'dictionary' ? vm.memory.entries(value) : undefined; let index = 0;
    vm.budget.allocate(16 * (2 + (entries?.length ?? 0) * 2), 'forall roots');
    const roots: PsValue[] = [value, proc];
    if (entries) for (const pair of entries) { vm.budget.work(); roots.push(pair[0], pair[1]); }
    vm.replace(2);
    vm.scheduleLoop(() => {
      if (value.kind === 'dictionary') {
        let key: PsValue | undefined, item: PsValue | undefined;
        while (index < entries!.length) {
          vm.budget.work(); key = entries![index++]![0]; item = vm.memory.lookup(value, key);
          if (item !== undefined) break;
        }
        if (item === undefined) return false; vm.push(key!); vm.push(item);
      } else { if (index === value.length) return false; vm.push(vm.memory.get(value, index++)); }
      vm.execute(proc); return true;
    }, roots);
  });
  op('exit', () => vm.exit()); op('stop', () => vm.stop()); op('quit', () => vm.quit());
  op('stopped', () => vm.scheduleStopped(vm.pop()));
  op('countexecstack', () => vm.push(integer(vm.executionDepth)));
  op('execstack', () => {
    const target = vm.typed('array'); if (!canWrite(target)) throw new PsFault('invalidaccess');
    if (target.length < vm.executionDepth) throw new PsFault('rangecheck');
    const values = vm.executionStack(); for (let i = 0; i < values.length; i++) vm.memory.put(target, i, values[i]!);
    vm.replace(1, vm.memory.interval(target, 0, values.length));
  });
  op('bind', () => {
    const root = vm.typed('array'); const pending: PsArray[] = []; const seen = new Map<PsArray['body'], Set<string>>();
    const push = (value: PsArray): void => { vm.budget.allocate(16, 'bind pending'); pending.push(value); }; push(root);
    while (pending.length) {
      vm.budget.work(); const array = pending.pop()!;
      if (!array.body.valid) throw new PsFault('invalidrestore');
      if (!array.body.packed && !canWrite(array)) continue;
      const key = `${array.offset}:${array.length}`;
      let views = seen.get(array.body); if (views?.has(key)) continue;
      vm.budget.allocate(96, 'bind visited view');
      if (!views) { views = new Set(); seen.set(array.body, views); } views.add(key);
      for (let i = 0; i < array.length; i++) {
        vm.budget.work(); const value = vm.memory.bindFetch(array, i);
        if (value.kind === 'name' && value.executable) { const binding = vm.lookup(value.text); if (binding?.kind === 'operator') vm.memory.bindReplace(array, i, binding); }
        else if (value.kind === 'array' && value.executable && (value.body.packed || canWrite(value))) {
          push(value);
          // Keep the original writable view for traversal; the reference in
          // its parent becomes readonly, while other aliases retain access.
          if (!value.body.packed) vm.memory.bindReplace(array, i, vm.memory.restrictAccess(value, 'readonly'));
        }
      }
    }
  });
}
