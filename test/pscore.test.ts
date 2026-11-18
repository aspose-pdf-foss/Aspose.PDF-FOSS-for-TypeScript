import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import type { PsValue } from '../src/psvalue.js';

const simple = (v: PsValue): unknown => 'value' in v ? v.value : v.kind === 'name' ? v.text : v.kind;
function run(source: string): unknown[] {
  const vm = new PsInterpreter(); vm.run(new TextEncoder().encode(source)); return vm.stack.map(simple);
}
describe('PostScript core operators', () => {
  it.each([
    ['1 2 add 9 4 sub 3 7 mul 7 2 div 7 2 idiv -7 3 mod', [3, 5, 21, 3.5, 3, -1]],
    ['2147483647 1 add type -2147483648 neg type 2.0 2 mul type', ['realtype', 'realtype', 'realtype']],
    ['-3 abs -2.6 ceiling 2.6 floor -2.5 round -2.9 truncate', [3, -2, 2, -2, -2]],
    ['9 sqrt 2 3 exp 1 ln 100 log 30 sin 60 cos 1 0 atan', [3, 8, 0, 2, 0.49999999999999994, 0.5000000000000001, 90]],
    ['true false and true false or true true xor false not 6 3 and 6 3 or 6 3 xor 0 not', [false, true, false, true, 2, 7, 5, -1]],
    ['1 32 bitshift -1 -1 bitshift -1 -32 bitshift 1 31 bitshift', [0, 2147483647, 0, -2147483648]],
    ['2 2.0 eq 2 3 ne 3 2 gt 3 3 ge 2 3 lt 2 2 le (abc) (abd) lt', [true, true, true, true, true, true, true]],
    ['1 2 exch dup 2 index 3 1 roll', [2, 2, 1, 1]],
    ['1 2 2 copy count', [1, 2, 1, 2, 4]],
    ['mark 1 2 counttomark cleartomark count', [0]],
    ['1 2 clear count', [0]],
    ['42 srand rand 42 srand rand eq rrand 0 ge', [true, true]],
  ])('evaluates %s', (source, expected) => expect(run(source)).toEqual(expected));
  it.each(['1 0 div', '1 0 idiv', '1 0 mod', '-1 sqrt', '0 ln', '0 log', '0 0 atan'])('rejects undefined results: %s', source => {
    expect(() => run(source)).toThrow(/undefinedresult/);
  });
  it.each(['1 true add', '1.0 2 and', 'true 2 or', '1.0 2 bitshift'])('validates operand types: %s', source => {
    expect(() => run(source)).toThrow(/typecheck/);
  });
  it.each([
    ['1 2 3 3 -1 roll', [2, 3, 1]],
    ['1 0 9 roll', [1]],
    ['(ab) (a) gt (a) (ab) le (ab) (ab) ge (ab) (ab) lt', [true, true, true, false]],
    ['-2147483648 abs type 2147483647 2147483647 mul type', ['realtype', 'realtype']],
    ['0 0 bitshift -8 -2 bitshift 8 2 bitshift', [0, 1073741822, 32]],
    ['1.5 0.5 2.5 {} for 3 -1 1 {} for', [1.5, 2, 2.5, 3, 2, 1]],
    ['1 2 null exec null cvx exec false exec', [1, 2, 'null', false]],
    ['{1 quit 2} exec 3', [1]],
  ])('covers supported core branches: %s', (source, expected) => expect(run(source)).toEqual(expected));
  it.each([
    ['-1 index', 'rangecheck'], ['1 2 3 roll', 'stackunderflow'], ['1 -1 0 roll', 'rangecheck'],
    ['-1 {} repeat', 'rangecheck'], ['1 true lt', 'typecheck'], ['-2147483648 -1 idiv', 'undefinedresult'],
  ])('rejects invalid core branches: %s', (source, fault) => expect(() => run(source)).toThrow(new RegExp(fault)));
});
