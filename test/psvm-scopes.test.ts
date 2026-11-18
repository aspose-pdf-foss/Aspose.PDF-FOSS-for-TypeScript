import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import { PsFault, integer, name } from '../src/psvalue.js';
import { ResourceLimitError } from '../src/errors.js';
import { LoadLimits } from '../src/loadlimits.js';

const bytes = (source: string) => new TextEncoder().encode(source);

describe('PostScript invocation scopes', () => {
  function machine(events: string[]) {
    const vm = new PsInterpreter();
    vm.registerOperator('call', () => {
      const procedure = vm.procedure();
      vm.replace(1);
      vm.invoke(procedure, {
        roots: [procedure],
        complete: () => events.push('complete'),
        unwind: () => events.push('unwind'),
      });
    });
    return vm;
  }

  it('completes after the callback and a returning error handler', () => {
    const events: string[] = [];
    const vm = machine(events);
    vm.run(bytes('errordict /undefined { pop 3 } put { 1 missing 2 } call 4'));
    expect(vm.stack).toMatchObject([{ value: 1 }, { value: 3 }, { value: 2 }, { value: 4 }]);
    expect(events).toEqual(['complete']);
  });

  it.each([
    ['{ { stop } call 9 } stopped 4', [true, 4]],
    ['{ { exit } call 9 } loop 4', [4]],
    ['{ quit } call 9', []],
  ])('unwinds the callback when executing %s', (source, values) => {
    const events: string[] = [];
    const vm = machine(events);
    vm.run(bytes(source));
    expect(events).toEqual(['unwind']);
    expect(vm.stack.map(value => 'value' in value ? value.value : value.kind)).toEqual(values);
    expect(vm.executionDepth).toBe(0);
  });

  it('keeps the invocation when a stopped boundary catches inside it', () => {
    const events: string[] = [];
    const vm = machine(events);
    vm.run(bytes('{ { stop } stopped 7 } call'));
    expect(events).toEqual(['complete']);
    expect(vm.stack).toMatchObject([{ value: true }, { value: 7 }]);
  });

  it('unwinds nested scopes in reverse order on terminal failures', () => {
    const events: string[] = [];
    const vm = machine(events);
    const failure = new ResourceLimitError('maxPostScriptOperations', 1, 2);
    vm.registerOperator('inner', () => vm.invoke(name('fail', true), {
      roots: [], complete: () => events.push('inner complete'),
      unwind: () => events.push('inner unwind'),
    }));
    vm.registerOperator('fail', () => { throw failure; });
    expect(() => vm.run(bytes('{ inner } call'))).toThrow(failure);
    expect(events).toEqual(['inner unwind', 'unwind']);
    expect(vm.executionDepth).toBe(0);
    vm.run(bytes('8'));
    expect(vm.stack).toMatchObject([{ value: 8 }]);
  });

  it('unwinds a scope whose completion throws', () => {
    const events: string[] = [];
    const vm = new PsInterpreter();
    vm.registerOperator('call', () => vm.invoke(integer(1), {
      roots: [], complete: () => { throw new PsFault('rangecheck'); },
      unwind: () => events.push('unwind'),
    }));
    expect(() => vm.run(bytes('call'))).toThrow(/rangecheck/);
    expect(events).toEqual(['unwind']);
  });

  it('includes invocation roots in restore validation', () => {
    const vm = new PsInterpreter();
    vm.registerOperator('retain', () => {
      const root = vm.memory.array(1);
      vm.invoke(vm.procedure(), { roots: [root], complete: () => {}, unwind: () => {} });
      vm.replace(1);
    });
    expect(() => vm.run(bytes('/restoreproc { s restore } def /s save def /restoreproc load retain')))
      .toThrow(/invalidrestore/);
  });

  it('does not leave an invocation frame if scheduling its value fails', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxNestingDepth: 2 }) });
    const events: string[] = [];
    vm.registerOperator('call', () => vm.invoke(integer(1), {
      roots: [], complete: () => events.push('complete'), unwind: () => events.push('unwind'),
    }));
    expect(() => vm.run(bytes('call'))).toThrowError(expect.objectContaining({ limit: 'maxNestingDepth' }));
    expect(events).toEqual(['unwind']);
    expect(vm.executionDepth).toBe(0);
  });
});

describe('PostScript VM save participants', () => {
  it('activates prepared snapshots only after a memory save succeeds', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxNestingDepth: 1 }) });
    let activated = 0;
    vm.addSaveParticipant({ prepareSave: () => ({
      visitRoots: () => {}, restore: () => {}, saved: () => { activated++; },
    }) });
    const outer = vm.save();
    expect(activated).toBe(1);
    expect(() => vm.save()).toThrowError(expect.objectContaining({ limit: 'maxNestingDepth' }));
    expect(activated).toBe(1);
    vm.restore(outer);
  });

  it('restores the snapshot belonging to the target save level', () => {
    const vm = new PsInterpreter();
    let state = 1;
    vm.addSaveParticipant({ prepareSave() {
      const saved = state;
      return { visitRoots: () => {}, restore: () => { state = saved; } };
    } });
    const outer = vm.save();
    state = 2;
    vm.save();
    state = 3;
    vm.restore(outer);
    expect(state).toBe(1);
  });

  it('validates prospective roots before changing memory or participant state', () => {
    const vm = new PsInterpreter();
    let restored = false;
    let root = integer(1) as import('../src/psvalue.js').PsValue;
    vm.addSaveParticipant({ prepareSave: () => ({
      visitRoots: visit => visit(root), restore: () => { restored = true; },
    }) });
    const save = vm.save();
    vm.memory.put(vm.userdict, name('x'), integer(5));
    root = vm.memory.array(1);
    expect(() => vm.restore(save)).toThrow(/invalidrestore/);
    expect(restored).toBe(false);
    expect(vm.lookup('x')).toMatchObject({ value: 5 });
    root = integer(1);
    vm.restore(save);
    expect(restored).toBe(true);
    expect(vm.lookup('x')).toBeUndefined();
  });

  it('does not create a memory save when preparation fails', () => {
    const vm = new PsInterpreter();
    let failed = true;
    vm.addSaveParticipant({ prepareSave() {
      if (failed) throw new PsFault('rangecheck');
      return { visitRoots: () => {}, restore: () => {} };
    } });
    expect(() => vm.save()).toThrow(/rangecheck/);
    failed = false;
    const save = vm.save();
    expect(() => vm.restore(save)).not.toThrow();
  });
});
