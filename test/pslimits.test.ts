import { describe, expect, it } from 'vitest';
import { PdfParseError, ResourceLimitError } from '../src/errors.js';
import { LoadLimits, type LimitField, type LoadLimitPatch } from '../src/loadlimits.js';
import { PsBudget } from '../src/psbudget.js';
import { PsMemory } from '../src/psmemory.js';
import { PsInterpreter } from '../src/psvm.js';
import { integer } from '../src/psvalue.js';

const bytes = (source: string): Uint8Array => new TextEncoder().encode(source);
function refused(action: () => void, limit: LimitField, allowed: number, reached?: number, detail?: string): ResourceLimitError {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ResourceLimitError);
  const result = error as ResourceLimitError;
  expect(result.limit).toBe(limit); expect(result.allowed).toBe(allowed);
  if (reached === undefined) expect(result.reached).toBeGreaterThan(allowed);
  else expect(result.reached).toBe(reached);
  if (detail !== undefined) expect(result.detail).toBe(detail);
  return result;
}
function machine(patch: LoadLimitPatch): PsInterpreter {
  return new PsInterpreter({ limits: LoadLimits.defaults.with(patch) });
}

describe('PostScript hostile-input limits (lw8w.1)', () => {
  it.each([
    '{} loop', '/x /x cvx def x', '/p {p} def p', '/s (s) cvx def s',
    '/s (s exec) cvx def /s load exec', '0 0 1 {} for',
  ])('charges empty or recursive execution without host recursion: %s', source => {
    const vm = machine({ maxPostScriptOperations: 10_000, maxNestingDepth: null, maxPostScriptVmBytes: null });
    refused(() => vm.run(bytes(source)), 'maxPostScriptOperations', 10_000);
    expect(vm.executionDepth).toBe(0); expect(vm.currentScanner).toBeUndefined();
  });

  it.each([
    ['{1} loop', { maxContainerItems: 8 }, 'maxContainerItems', 8, 9],
    ['0 dict begin 0 {dup 1 def 1 add} loop', { maxContainerItems: 8 }, 'maxContainerItems', 8, 9],
    ['{0 dict begin} loop', { maxNestingDepth: 8 }, 'maxNestingDepth', 8, 9],
    ['/p {p} def p', { maxNestingDepth: 8 }, 'maxNestingDepth', 8, 9],
    ['{{{{{{{{{}}}}}}}}}', { maxNestingDepth: 8 }, 'maxNestingDepth', 8, 9],
    ['{save pop} loop', { maxNestingDepth: 8 }, 'maxNestingDepth', 8, 9],
    ['2147483647 array', { maxContainerItems: 16 }, 'maxContainerItems', 16, 2147483647],
    ['2147483647 array', { maxContainerItems: null, maxPostScriptVmBytes: 4096 }, 'maxPostScriptVmBytes', 4096, undefined],
    ['{100 array pop} loop', { maxPostScriptVmBytes: 16_384, maxPostScriptOperations: null }, 'maxPostScriptVmBytes', 16_384, undefined],
    ['{save 100 array pop restore} loop', { maxPostScriptVmBytes: 100_000, maxPostScriptOperations: null }, 'maxPostScriptVmBytes', 100_000, undefined],
  ] satisfies [string, LoadLimitPatch, LimitField, number, number | undefined][])('refuses bounded growth before native allocation: %s', (source, patch, limit, allowed, reached) => {
    const vm = machine(patch);
    refused(() => vm.run(bytes(source)), limit, allowed, reached);
    expect(vm.executionDepth).toBe(0);
  });

  it('allows the source-byte boundary and refuses the next byte before scanning', () => {
    machine({ maxFileBytes: 3 }).run(bytes('1 2'));
    const vm = machine({ maxFileBytes: 3 });
    refused(() => vm.run(bytes('1 2 ')), 'maxFileBytes', 3, 4, 'PostScript source');
    expect(vm.stack).toEqual([]); expect(vm.executionDepth).toBe(0);
    vm.run(bytes('7')); expect(vm.stack).toEqual([integer(7)]);
  });

  it.each(['(abc)', '/abcd', '<4142>', '<~z~>', '{1 2}'])('bounds the complete encoded token span: %s', source => {
    machine({ maxObjectBytes: source.length }).run(bytes(source));
    refused(() => machine({ maxObjectBytes: source.length - 1 }).run(bytes(source)), 'maxObjectBytes', source.length - 1, source.length);
  });

  it('meters whitespace and comments as source work', () => {
    for (const source of [' '.repeat(256), '%' + 'x'.repeat(256)]) {
      refused(() => machine({ maxPostScriptOperations: 64 }).run(bytes(source)), 'maxPostScriptOperations', 64, 65, 'PostScript source byte');
    }
  });

  it('accounts exact operation boundaries across runs with no bootstrap exemption for source', () => {
    const vm = machine({ maxPostScriptOperations: 1 });
    vm.run(bytes('')); // One source-frame pump turn, even without a token.
    refused(() => vm.run(bytes('')), 'maxPostScriptOperations', 1, 2);
    expect(vm.executionDepth).toBe(0);
    machine({ maxPostScriptOperations: 6 }).run(bytes('1'));
    refused(() => machine({ maxPostScriptOperations: 5 }).run(bytes('1')), 'maxPostScriptOperations', 5, 6);
  });

  it('accounts exact allocation boundaries across runs without refunding discarded frames', () => {
    const vm = machine({ maxPostScriptVmBytes: 160 });
    vm.run(bytes('')); // 96-byte source frame and 64-byte operand undo buffer.
    refused(() => vm.run(bytes('')), 'maxPostScriptVmBytes', 160, 256, 'execution frame');
    refused(() => machine({ maxPostScriptVmBytes: 159 }).run(bytes('')), 'maxPostScriptVmBytes', 159, 160, 'operand undo buffer');
    expect(vm.executionDepth).toBe(0);
  });

  it.each(['maxPostScriptOperations', 'maxPostScriptVmBytes'] as const)('does not dispatch %s through stopped or custom language handlers', limit => {
    const vm = machine({ [limit]: 20_000 }); let handled = false;
    vm.registerOperator('caughtlimit', () => { handled = true; });
    vm.run(bytes('errordict /limitcheck {caughtlimit stop} put errordict /VMerror {caughtlimit stop} put'));
    refused(() => vm.run(bytes('{{} loop} stopped 99')), limit, 20_000);
    expect(handled).toBe(false); expect(vm.stack.some(v => v.kind === 'integer' && v.value === 99)).toBe(false);
    expect(vm.executionDepth).toBe(0); expect(vm.currentScanner).toBeUndefined();
  });

  it('lets resource exhaustion escape an already executing error handler', () => {
    const vm = machine({ maxPostScriptOperations: 10_000 }); let entered = false;
    vm.registerOperator('entered', () => { entered = true; });
    refused(() => vm.run(bytes('errordict /typecheck {entered {} loop} put {1 true add} stopped')), 'maxPostScriptOperations', 10_000);
    expect(entered).toBe(true); expect(vm.executionDepth).toBe(0);
  });

  it('unwinds language and host terminal errors and permits a following run', () => {
    const vm = new PsInterpreter();
    expect(() => vm.run(bytes('{missing} exec'))).toThrow(PdfParseError);
    expect(vm.executionDepth).toBe(0); expect(vm.currentScanner).toBeUndefined();
    const hostError = new Error('embedding failure');
    vm.registerOperator('hostfail', () => { throw hostError; });
    expect(() => vm.run(bytes('{hostfail} stopped'))).toThrow(hostError);
    expect(vm.executionDepth).toBe(0); expect(vm.currentScanner).toBeUndefined();
    vm.run(bytes('clear 7')); expect(vm.stack).toEqual([integer(7)]);
  });

  it('bounds overlapping-copy scratch before changing a shared array', () => {
    const memory = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 2319 })));
    const array = memory.arrayFrom(Array.from({ length: 100 }, (_, i) => integer(i)));
    const source = memory.interval(array, 0, 41), target = memory.interval(array, 1, 41);
    refused(() => memory.copy(source, target), 'maxPostScriptVmBytes', 2319, 2320, 'copy');
    expect(memory.get(array, 1)).toEqual(integer(1));
    const exact = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 2320 })));
    const permitted = exact.arrayFrom(Array.from({ length: 100 }, (_, i) => integer(i)));
    exact.copy(exact.interval(permitted, 0, 41), exact.interval(permitted, 1, 41));
    expect(exact.get(permitted, 1)).toEqual(integer(0));
    expect(exact.get(permitted, 41)).toEqual(integer(40));
  });

  it.each(['maxPostScriptOperations', 'maxPostScriptVmBytes'] as const)('bounds proportional save-journal %s before mutation', limit => {
    const allowed = limit === 'maxPostScriptOperations' ? 200 : 3391;
    const memory = new PsMemory(new PsBudget(LoadLimits.defaults.with({ [limit]: allowed })));
    const array = memory.array(100); memory.save();
    refused(() => memory.put(array, 0, integer(9)), limit, allowed, allowed + 1, 'save journal');
    expect(memory.get(array, 0).kind).toBe('null');
    const exact = new PsMemory(new PsBudget(LoadLimits.defaults.with({ [limit]: allowed + 1 })));
    const permitted = exact.array(100); exact.save(); exact.put(permitted, 0, integer(9));
    expect(exact.get(permitted, 0)).toEqual(integer(9));
  });

  it('bounds bind traversal of a cyclic graph while allowing small cycles to finish', () => {
    const large = machine({ maxPostScriptVmBytes: 32_000 });
    const bind = large.lookup('bind');
    if (bind?.kind !== 'operator') throw new Error('missing bind operator');
    const root = large.memory.array(1000, true);
    for (let i = 0; i < root.length; i++) large.memory.put(root, i, root);
    large.push(root);
    refused(() => bind.execute(), 'maxPostScriptVmBytes', 32_000, undefined, 'bind pending');
    const vm = machine({ maxPostScriptOperations: 10_000 });
    vm.run(bytes('/p 1 array cvx def /p load 0 /p load put /p load bind pop 7'));
    expect(vm.stack).toEqual([integer(7)]);
  });

  it.each(['search', 'anchorsearch'])('meters long shared-prefix comparisons in %s', op => {
    // Invoke the real operator on embedding-supplied strings so the source
    // scanner cannot be the component that exhausts the work budget.
    const vm = machine({ maxPostScriptOperations: 20_000 });
    const operator = vm.lookup(op); expect(operator?.kind).toBe('operator');
    if (operator?.kind !== 'operator') throw new Error('missing search operator');
    vm.push(vm.memory.string(bytes('a'.repeat(10_000))));
    vm.push(vm.memory.string(bytes('a'.repeat(6000) + 'b')));
    refused(() => operator.execute(), 'maxPostScriptOperations', 20_000, 20_001);
  });
});
