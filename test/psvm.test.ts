import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import { PdfParseError } from '../src/errors.js';
import { ResourceLimitError, UnsupportedFeatureError } from '../src/errors.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PsFault, integer } from '../src/psvalue.js';

const bytes = (source: string) => new TextEncoder().encode(source);
describe('PostScript iterative embedding', () => {
  it('pushes typed literal objects without executing procedure literals', () => {
    const vm = new PsInterpreter(); vm.run(bytes('1 2.0 /name (abc) { 7 }'));
    expect(vm.stack.map(value => value.kind)).toEqual(['integer', 'real', 'name', 'string', 'array']);
  });
  it('converts uncaught named faults into offset-bearing public parse errors', () => {
    const vm = new PsInterpreter();
    expect(() => vm.run(bytes('missing'))).toThrow(PdfParseError);
    expect(() => vm.run(bytes('missing'))).toThrow(/undefined.*byte 0/);
    expect(() => vm.run(bytes('(bad'))).toThrow(/syntaxerror.*byte 0/);
  });
  it.each([
    ['/f {1 2 add} def f {4} exec', [3, 4]],
    ['/a /b cvx def /b /c cvx def /c 9 def a', [9]],
    ['/x 1 def //x /x 2 def //x /f {//x} def /x 3 def f', [1, 2, 2]],
    ['true {1} if false {2} if true {3} {4} ifelse false {5} {6} ifelse', [1, 3, 6]],
    ['0 1 1 4 {add} for 4 -1 1 {} for 0 {99} repeat', [10, 4, 3, 2, 1]],
    ['0 3 {1 add} repeat {4 exit 9} loop 7', [3, 4, 7]],
    ['[1 2] {} forall (ab) {} forall << /x 7 >> {exch pop} forall', [1, 2, 97, 98, 7]],
    ['2 {3 {1 exit} repeat 2} repeat', [1, 2, 1, 2]],
    ['(1 2 add) cvx exec (4 5 add) cvx executeonly exec', [3, 9]],
    ['{1 2 add} executeonly exec', [3]],
    ['/f {1 2 add} bind def /add {pop pop 99} def f 1 2 add', [3, 99]],
    ['{1} stopped {2 stop 3} stopped 4', [1, false, 2, true, 4]],
    ['1 stop 2', [1]],
    ['1 quit 2', [1]],
  ])('schedules %s', (source, want) => {
    const vm = new PsInterpreter(); vm.run(bytes(source));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind)).toEqual(want);
  });
  it('retains definitions and permits registered operators to consume the live scanner', () => {
    const vm = new PsInterpreter();
    vm.run(bytes('/x 7 def'));
    vm.registerOperator('skip', machine => { machine.currentScanner!.position += 4; machine.push(integer(9)); });
    vm.run(bytes('x skip abc 2'));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind)).toEqual([7, 9, 2]);
  });
  it.each([' ', '\n', '\r', '\r\n'])('positions the live cursor beyond one separator %j before inline data', separator => {
    const vm = new PsInterpreter();
    vm.registerOperator('read', machine => {
      const scan = machine.currentScanner!;
      expect(scan.source[scan.position]).toBe(88);
      scan.position++;
    });
    vm.run(bytes('read' + separator + 'X 7'));
    expect(vm.stack).toEqual([integer(7)]);
  });
  it('executes source after a form-feed comment terminator', () => {
    const vm = new PsInterpreter(); vm.run(bytes('% comment\f42'));
    expect(vm.stack).toEqual([integer(42)]);
  });
  it.each([
    ['  (bad', '(bad', 2], ['  {1 (bad', '(bad', 5], ['  {1', '{1', 2],
    ['  <GG>', '<G', 2], ['  <~!v~>', '<~!v', 2], ['  )', ')', 2],
  ])('passes scanned malformed text to a custom syntax handler: %s', (source, command) => {
    const vm = new PsInterpreter(); vm.run(bytes('errordict /syntaxerror {dup type quit} put'));
    vm.run(bytes(source));
    expect(vm.stack).toMatchObject([{kind:'string',executable:false,length:command.length,body:{bytes:bytes(command)}}, {kind:'name',text:'stringtype'}]);
  });
  it.each([
    ['  (bad', '(bad', 2], ['  {1 (bad', '(bad', 5], ['  {1', '{1', 2],
    ['(  \\(bad) cvx exec', '(bad', 2],
  ])('records malformed scanned text and original offset in standard errors: %s', (source, command, offset) => {
    const vm = new PsInterpreter();
    expect(() => vm.run(bytes(source))).toThrowError(expect.objectContaining({offset}));
    expect(vm.memory.get(vm.error, vm.memory.name('command'))).toMatchObject({kind:'string',executable:false,length:command.length,body:{bytes:bytes(command)}});
  });
  it('passes executable-string syntax text through a custom handler inside stopped', () => {
    const vm = new PsInterpreter();
    vm.run(bytes('errordict /syntaxerror {dup type stop} put {(  \\(bad) cvx exec} stopped'));
    expect(vm.stack).toMatchObject([{kind:'string',length:4,body:{bytes:bytes('(bad')}}, {kind:'name',text:'stringtype'}, {kind:'boolean',value:true}]);
  });
  it('lets diagnostic allocation exhaustion escape the embedding error boundary', () => {
    // Source frame + undo = 160; malformed string builder = 144;
    // error-token view = 64; diagnostic string = 68, totaling 436.
    const vm = new PsInterpreter({limits:LoadLimits.defaults.with({maxPostScriptVmBytes:435})});
    expect(() => vm.run(bytes('(bad'))).toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes',allowed:435,reached:436,detail:'string'}));
    expect(vm.executionDepth).toBe(0);
  });
  it('lets resource exhaustion escape a custom syntax handler and stopped', () => {
    const vm = new PsInterpreter({limits:LoadLimits.defaults.with({maxPostScriptOperations:10000})});
    let entered = false;
    vm.registerOperator('entered', machine => {
      expect(machine.peek()).toMatchObject({kind:'string',length:4,body:{bytes:bytes('(bad')}});
      entered = true;
    });
    expect(() => vm.run(bytes('errordict /syntaxerror {entered {} loop} put {(\\(bad) cvx exec} stopped 99'))).toThrow(ResourceLimitError);
    expect(entered).toBe(true); expect(vm.executionDepth).toBe(0);
    expect(vm.stack.some(v => v.kind === 'integer' && v.value === 99)).toBe(false);
  });
  it('bind terminates on cyclic procedure graphs', () => {
    const vm = new PsInterpreter(); vm.run(bytes('/p 1 array cvx def /p load 0 /p load put /p load bind pop 7'));
    expect(vm.stack).toEqual([integer(7)]);
  });
  it('exposes bounded execution-stack views', () => {
    const vm = new PsInterpreter(); vm.run(bytes('{countexecstack 10 array execstack length eq} exec'));
    expect(vm.stack).toEqual([{ kind: 'boolean', value: true, executable: false }]);
  });
  it.each(['{} loop', '/f {f} def f', '/x /x cvx def x', '/s (s) cvx def s'])('bounds iterative execution: %s', source => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptOperations: 15000, maxNestingDepth: null }) });
    expect(() => vm.run(bytes(source))).toThrow(ResourceLimitError);
  });
  it.each(['exit'])('rejects exit outside a loop: %s', source => {
    const vm = new PsInterpreter(); expect(() => vm.run(bytes(source))).toThrow(/invalidexit/);
  });
  it.each([
    ['{1 true add} stopped $error /errorname get $error /newerror get', [1, true, true, 'typecheck', true]],
    ['errordict /typecheck {pop pop pop 42} put 1 true add 7', [42, 7]],
    ['{missing} stopped $error /command get type', [true, 'nametype']],
    ['{1 {exit} stopped exit} loop', [1, true]],
    ['{(bad) cvx exec} stopped', [true]],
    ['systemdict gcheck systemdict wcheck userdict gcheck globaldict gcheck', [true, false, false, true]],
    ['[1] /a exch def save /s exch def a 0 2 put s restore a 0 get', [1]],
    ['save true setpacking true setglobal restore currentpacking currentglobal', [false, false]],
    ['(a) /s exch def save s 0 88 put restore s 0 get', [88]],
    ['true setglobal [1] /a exch def false setglobal save a 0 9 put restore a 0 get', [9]],
    ['save 1 array exch {restore} stopped $error /errorname get', ['array', 'save', true, 'invalidrestore']],
  ])('recovers faults and VM state: %s', (source, want) => {
    const vm = new PsInterpreter(); vm.run(bytes(source));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind === 'name' ? v.text : v.kind)).toEqual(want);
  });
  it('restores only touched operands after a registered operator faults', () => {
    const vm = new PsInterpreter();
    vm.registerOperator('fail', machine => { machine.pop(); machine.push(integer(99)); machine.pop(); machine.pop(); throw new PsFault('typecheck'); });
    vm.run(bytes('1 2 3 {fail} stopped'));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind)).toEqual([1, 2, 3, true]);
  });
  it('keeps executable string objects live during restore', () => {
    const vm = new PsInterpreter();
    expect(() => vm.run(bytes('save /s exch def (s restore) cvx exec'))).toThrow(/invalidrestore/);
  });
  it('does not let stopped catch resource or unsupported errors', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptOperations: 10000 }) });
    expect(() => vm.run(bytes('{{} loop} stopped'))).toThrow(ResourceLimitError);
    const other = new PsInterpreter(); other.registerOperator('unsupported', () => { throw new UnsupportedFeatureError('device'); });
    expect(() => other.run(bytes('{unsupported} stopped'))).toThrow(UnsupportedFeatureError);
  });
  it('bounds repeated exec of an operator without host recursion', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptOperations: 15000, maxNestingDepth: null }) });
    vm.registerOperator('again', machine => machine.execute(machine.lookup('again')!));
    expect(() => vm.run(bytes('again'))).toThrow(ResourceLimitError);
  });
  it('does not allow writes to systemdict after bootstrap', () => {
    const vm = new PsInterpreter(); expect(() => vm.run(bytes('systemdict /new 1 put'))).toThrow(/invalidaccess/);
  });
  it.each([
    ['true setpacking /p {1 2 add} def /p load bind pop /add {pop pop 9} def p', [3]],
    ['true setpacking /p {1 2 add} def /p load noaccess bind pop /add {pop pop 9} def p', [3]],
    ['/p {{1 2 add}} def /p load bind pop /p load dup wcheck exch 0 get wcheck', [true, false]],
    ['/p {1 2 add} readonly def /p load bind pop /add {pop pop 9} def p', [9]],
    ['/a 2 array def a 0 /add cvx put a 1 /add cvx put /p [a 0 1 getinterval cvx a 1 1 getinterval cvx] cvx def /p load bind pop a 0 get type a 1 get type', ['operatortype', 'operatortype']],
    ['true setpacking /p {add} def save /p load bind pop restore /p load 0 get type', ['nametype']],
  ])('bind preserves access, shared views and save journals: %s', (source, want) => {
    const vm = new PsInterpreter(); vm.run(bytes(source));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind === 'name' ? v.text : v.kind)).toEqual(want);
  });
  it.each([
    ['  missing', 2], ['  //missing', 2], ['/p {missing} def   p', 19], ['(  missing) cvx exec', 2], ['  (bad', 2],
  ])('reports a token-start offset for %s', (source, offset) => {
    const vm = new PsInterpreter();
    try { vm.run(bytes(source)); throw new Error('expected parse error'); }
    catch (caught) { expect(caught).toBeInstanceOf(PdfParseError); expect((caught as PdfParseError).offset).toBe(offset); }
  });
  it('checks execution access even on empty procedures', () => {
    const vm = new PsInterpreter(); expect(() => vm.run(bytes('{} noaccess exec'))).toThrow(/invalidaccess/);
  });
  it('preserves original syntax-error offset through standard handlers', () => {
    const vm = new PsInterpreter();
    try { vm.run(bytes('  {1 (bad')); throw new Error('expected fault'); }
    catch (caught) { expect(caught).toBeInstanceOf(PdfParseError); expect((caught as PdfParseError).offset).toBe(5); }
  });
  it('honors small dictionary and stack depth bounds after uncharged bootstrap', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxNestingDepth: 1 }) });
    vm.run(bytes('0 dict begin end 7'));
    expect(vm.stack).toEqual([integer(7)]);
    expect(() => vm.run(bytes('0 dict begin 0 dict begin'))).toThrow(ResourceLimitError);
    const stack = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxContainerItems: 2 }) });
    stack.run(bytes('1 2')); expect(stack.stack).toHaveLength(2);
    expect(() => stack.run(bytes('3'))).toThrowError(expect.objectContaining({ limit: 'maxContainerItems', allowed: 2, reached: 3 }));
  });
  it('meters ordinary stack operations without copying the full operand stack', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptVmBytes: 1000000, maxPostScriptOperations: null }) });
    vm.run(bytes('1 '.repeat(1000) + 'dup pop '.repeat(1000)));
    expect(vm.stack).toHaveLength(1000);
  });
  it('meters repeated host scheduling without relying on lookup cost or host recursion', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptOperations: 100000, maxNestingDepth: null }) });
    let again: ReturnType<PsInterpreter['lookup']>;
    vm.registerOperator('again', machine => machine.execute(again!)); again = vm.lookup('again');
    expect(() => vm.run(bytes('again'))).toThrow(ResourceLimitError);
  });
  it('shares operations and allocation budgets between repeated runs', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptVmBytes: 800 }) });
    vm.run(bytes('1')); vm.run(bytes('2'));
    expect(() => vm.run(bytes('3 4 5'))).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
  });
  it.each([
    ['1000000 array', { maxContainerItems: 5 }],
    ['1000000 string', { maxPostScriptVmBytes: 1000 }],
    ['{} loop', { maxPostScriptOperations: 10000 }],
    ['/p {p} def p', { maxNestingDepth: 8 }],
    ['100 {1} repeat', { maxContainerItems: 5 }],
  ])('bounds source-controlled growth/work: %s', (source, limits) => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with(limits) });
    expect(() => vm.run(bytes(source))).toThrow(ResourceLimitError);
  });
  it('meters the inner comparisons of pathological string searches', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptOperations: 100000 }) });
    expect(() => vm.run(bytes(`(${'a'.repeat(4000)}) (${'a'.repeat(500)}b) search`))).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
  });
  it('lets custom handlers choose whether to record $error', () => {
    const vm = new PsInterpreter(); vm.run(bytes('errordict /typecheck {pop pop pop 42} put 1 true add $error /newerror get'));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind)).toEqual([42, false]);
  });
  it('records an explicitly invoked standard handler with a separate offending command', () => {
    const vm = new PsInterpreter(); vm.run(bytes('{7 /manual errordict /typecheck get exec} stopped $error /errorname get $error /command get $error /ostack get length'));
    expect(vm.stack.slice(-3).map(v => 'value' in v ? v.value : v.kind === 'name' ? v.text : v.kind)).toEqual(['typecheck', 'manual', 1]);
  });
  it('standard handlers select local allocation and snapshot operands before the error', () => {
    const vm = new PsInterpreter(); vm.run(bytes('true setglobal {1 true add} stopped currentglobal $error /ostack get length'));
    expect(vm.stack.slice(-2)).toEqual([{ kind: 'boolean', executable: false, value: false }, integer(2)]);
  });
  it('applies the object-span bound to requested byte strings', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxObjectBytes: 10 }) });
    expect(() => vm.run(bytes('1000 string'))).toThrowError(expect.objectContaining({ limit: 'maxObjectBytes', allowed: 10, reached: 1000 }));
  });
  it('does not enumerate dictionary entries removed during forall', () => {
    const vm = new PsInterpreter();
    vm.run(bytes('/d << /a 1 /b 2 /c 3 >> def d {pop pop d /a undef d /b undef d /c undef 7} forall'));
    expect(vm.stack).toEqual([integer(7)]);
  });
  it('reads dictionary values at each forall iteration', () => {
    const vm = new PsInterpreter();
    vm.run(bytes('/d << /a 1 /b 2 /c 3 >> def d {exch pop d /a 9 put d /b 9 put d /c 9 put} forall'));
    expect(vm.stack.slice(1)).toEqual([integer(9), integer(9)]);
  });
  it.each([
    'false {} noaccess if',
    'true {} {} noaccess ifelse',
    'false {} noaccess {} ifelse',
    '0 {} noaccess repeat',
    '2 1 1 {} noaccess for',
    '[] {} noaccess forall',
    '{} noaccess loop',
  ])('checks procedure execution access before skipping or consuming it: %s', source => {
    const vm = new PsInterpreter();
    expect(() => vm.run(bytes(source))).toThrow(/invalidaccess/);
  });
  it.each([['{} noaccess', 'array'], ['(1) cvx noaccess', 'string']])('retains the inaccessible exec operand and names exec as the faulting command: %s', (operand, kind) => {
    const vm = new PsInterpreter();
    vm.run(bytes(`{${operand} exec} stopped $error /ostack get length $error /command get type`));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind === 'name' ? v.text : v.kind)).toEqual([kind, true, 1, 'operatortype']);
  });
  it('executes valid literal objects by pushing them back', () => {
    const vm = new PsInterpreter(); vm.run(bytes('[1] exec (2) exec 3 exec'));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind)).toEqual(['array', 'string', 3]);
  });
  it.each(['{} noaccess', '(1) cvx noaccess'])('catches execution access faults inside stopped: %s', operand => {
    const vm = new PsInterpreter();
    vm.run(bytes(`${operand} stopped $error /errorname get`));
    expect(vm.stack.map(v => 'value' in v ? v.value : v.kind === 'name' ? v.text : v.kind)).toEqual([true, 'invalidaccess']);
  });
});
