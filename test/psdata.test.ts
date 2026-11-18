import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import type { PsValue } from '../src/psvalue.js';

function simple(v: PsValue): unknown {
  if ('value' in v) return v.value;
  if (v.kind === 'name') return v.text;
  if (v.kind === 'string') return String.fromCharCode(...v.body.bytes.subarray(v.offset, v.offset + v.length));
  if (v.kind === 'array') return v.body.values.slice(v.offset, v.offset + v.length).map(simple);
  return v.kind;
}
function run(source: string): unknown[] {
  const vm = new PsInterpreter(); vm.run(new TextEncoder().encode(source)); return vm.stack.map(simple);
}
describe('PostScript data operators', () => {
  it.each([
    ['/x 7 def x /x load 1 dict begin /x 9 def x end x', [7, 7, 9, 7]],
    ['/x 1 def 1 dict begin /x 2 store end x /missing 3 store missing', [2, 3]],
    ['<< /a 1 /b 2 >> dup /a known exch dup /a undef /a known /zzz where', [true, false, false]],
    ['/a 1 def /a where pop userdict eq currentdict userdict eq countdictstack', [true, true, 3]],
    ['2 dict dup maxlength exch length 0 dict begin cleardictstack countdictstack', [2, 0, 3]],
    ['3 array dictstack length', [3]],
    ['[1 2 3] dup 1 9 put aload pop', [1, 9, 3]],
    ['1 2 3 3 array astore aload pop', [1, 2, 3]],
    ['[1 2 3] dup 1 2 getinterval dup 0 7 put pop aload pop', [1, 7, 3]],
    ['[1 2 3 4] dup 1 [8 9] putinterval aload pop', [1, 8, 9, 4]],
    ['(abcd) dup 1 2 getinterval 0 88 put', ['aXcd']],
    ['(abcd) dup 1 (ZZ) putinterval dup 0 get exch length', [97, 4]],
    ['(abc) 5 string copy', ['abc']],
    ['[1 2] 4 array copy aload pop', [1, 2]],
    ['<< /a 1 >> << /b 2 >> copy dup /a get exch /b get', [1, 2]],
    ['1 2 2 packedarray dup type exch aload pop currentpacking true setpacking currentpacking {1} type', ['packedarraytype', 1, 2, false, true, 'packedarraytype']],
    ['(abcabc) (bc) search', ['abc', 'bc', 'a', true]],
    ['(abc) (z) search (abc) (ab) anchorsearch (abc) (bc) anchorsearch', ['abc', false, 'c', 'ab', true, 'abc', false]],
    ['( 12 34) token ( ) token', ['34', 12, true, false]],
    ['/x 7 def (//x rest) token', ['rest', 7, true]],
    ['(15 (St1) {1 2 add}) token', ['(St1) {1 2 add}', 15, true]],
    ['(abc  def) token', [' def', 'abc', true]],
    ['(% comment\f42) token', ['', 42, true]],
    ['/x cvx xcheck /x cvx cvlit xcheck 1 type true type null type', [true, false, 'integertype', 'booleantype', 'nulltype']],
    ['3.9 cvi -3.9 cvi 2 cvr type (16#ff) cvi (2.5) cvr (hello) cvn', [3, -3, 'realtype', 255, 2.5, 'hello']],
    ['123 12 string cvs /hello 10 string cvs true 8 string cvs 255 16 10 string cvrs -1 16 10 string cvrs', ['123', 'hello', 'true', 'FF', 'FFFFFFFF']],
    ['[1] readonly dup rcheck exch wcheck {1} executeonly dup rcheck exch wcheck (a) noaccess dup rcheck exch wcheck', [true, false, false, false, false, false]],
    ['currentglobal true setglobal 1 array gcheck false setglobal 1 array gcheck 1 gcheck', [false, true, false, true]],
  ])('evaluates %s', (source, expected) => expect(run(source)).toEqual(expected));
  it.each([
    ['end', 'dictstackunderflow'], ['1 begin', 'typecheck'], ['[1] 3 get', 'rangecheck'],
    ['<< /a >>', 'rangecheck'], ['1 packedarray', 'stackunderflow'], ['1 1 packedarray 0 2 put', 'invalidaccess'],
    ['(a) readonly 0 1 put', 'invalidaccess'], ['(a) executeonly length', 'invalidaccess'],
    ['(oops) cvi', 'typecheck'], ['1 1 string cvrs', 'stackunderflow'],
    ['true setglobal 1 array false setglobal dup 0 1 array put', 'invalidaccess'],
  ])('rejects %s with %s', (source, fault) => expect(() => run(source)).toThrow(new RegExp(fault)));
  it('preserves real syntax when converting numbers to strings', () => {
    expect(run('2.0 10 string cvs 2.0 10 10 string cvrs')).toEqual(['2.0', '2.0']);
  });
  it('converts only the first numeric string token', () => {
    expect(run('(12 trailing) cvi (2.5 trailing) cvr')).toEqual([12, 2.5]);
    expect(() => run('( ) cvi')).toThrow(/syntaxerror/);
  });
  it('uses the operator name when converting an operator to a string', () => {
    expect(run('/add load 20 string cvs')).toEqual(['add']);
  });
  it.each([
    ['(xy) () search', ['xy', '', '', true]],
    ['(xy) () anchorsearch', ['xy', '', true]],
    ['() (x) search () (x) anchorsearch', ['', false, '', false]],
    ['(ab) cvx cvn xcheck (cd) cvn xcheck /xyz length', [true, false, 3]],
    ['0 packedarray dup rcheck exch wcheck', [true, false]],
    ['<< /x 1 >> dup readonly pop wcheck', [false]],
    ['0 dict dup /absent undef length', [0]],
    ['(text) 8 string cvs null 16 string cvs', ['text', '--nostringval--']],
  ])('covers supported data branches: %s', (source, expected) => expect(run(source)).toEqual(expected));
  it.each([
    ['1 1 12 string cvrs', 'rangecheck'], ['1 37 12 string cvrs', 'rangecheck'],
    ['99 1 string cvs', 'rangecheck'], ['1e20 cvi', 'rangecheck'],
    ['1e20 16 12 string cvrs', 'rangecheck'], ['1 dict executeonly', 'typecheck'],
    ['[1] noaccess readonly', 'invalidaccess'], ['1 rcheck', 'typecheck'],
  ])('rejects unsupported operand branches: %s', (source, fault) => expect(() => run(source)).toThrow(new RegExp(fault)));
});
