import { describe, it, expect } from 'vitest';
import { parsePostScriptFunction, evalPostScript } from '../src/psfunc.js';

/** Parse and run `src`, returning `nOut` outputs, or undefined on any fault. */
function run(src: string, input: number[] = [], nOut = 1): number[] | undefined {
  const prog = parsePostScriptFunction(new TextEncoder().encode(src));
  return prog === undefined ? undefined : evalPostScript(prog, input, nOut);
}
const approx = (v: number[] | undefined, n = 6): number[] | undefined =>
  v?.map((x) => +x.toFixed(n));

describe('type 4 arithmetic', () => {
  it('does the four basic operations', () => {
    expect(run('{ 3 4 add }')).toEqual([7]);
    expect(run('{ 10 3 sub }')).toEqual([7]);
    expect(run('{ 3 4 mul }')).toEqual([12]);
    expect(run('{ 7 2 div }')).toEqual([3.5]);
  });

  it('treats idiv and mod as integer operations', () => {
    // The case that separates a real implementation from a plausible one:
    // `div` here is 0.5, and a single-numeric-type interpreter returns it.
    expect(run('{ 7 2 idiv }')).toEqual([3]);
    expect(run('{ 1 2 idiv }')).toEqual([0]);
    expect(run('{ -7 2 idiv }')).toEqual([-3]);      // truncates toward zero
    expect(run('{ 7 2 mod }')).toEqual([1]);
    expect(run('{ -7 2 mod }')).toEqual([-1]);
  });

  it('converts and rounds', () => {
    expect(run('{ 3.7 cvi }')).toEqual([3]);
    expect(run('{ -3.7 cvi }')).toEqual([-3]);       // toward zero, not floor
    expect(run('{ 3 cvr }')).toEqual([3]);
    expect(run('{ 3.7 truncate }')).toEqual([3]);
    expect(run('{ 3.2 floor }')).toEqual([3]);
    expect(run('{ 3.2 ceiling }')).toEqual([4]);
    expect(run('{ 3.5 round }')).toEqual([4]);
    expect(run('{ -3.5 round }')).toEqual([-3]);     // ties toward +inf
  });

  it('does powers, roots and logarithms', () => {
    expect(run('{ 2 3 exp }')).toEqual([8]);
    expect(run('{ 9 sqrt }')).toEqual([3]);
    expect(run('{ 100 log }')).toEqual([2]);
    expect(approx(run('{ 1 ln }'))).toEqual([0]);
    expect(run('{ -5 abs }')).toEqual([5]);
    expect(run('{ 5 neg }')).toEqual([-5]);
  });

  it('does trigonometry in DEGREES, with atan in 0..360', () => {
    // Radians here produce a smooth, entirely plausible, entirely wrong ramp.
    expect(approx(run('{ 90 sin }'))).toEqual([1]);
    expect(approx(run('{ 0 sin }'))).toEqual([0]);
    expect(approx(run('{ 0 cos }'))).toEqual([1]);
    expect(approx(run('{ 180 cos }'))).toEqual([-1]);
    expect(approx(run('{ 60 sin }'), 4)).toEqual([0.866]);
    // `num den atan`, result in degrees, never negative.
    expect(approx(run('{ 0 1 atan }'))).toEqual([0]);
    expect(approx(run('{ 1 0 atan }'))).toEqual([90]);
    expect(approx(run('{ 0 -1 atan }'))).toEqual([180]);
    expect(approx(run('{ -1 0 atan }'))).toEqual([270]);
  });
});

describe('type 4 booleans and bitwise', () => {
  it('compares', () => {
    expect(run('{ 3 4 lt { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ 4 3 lt { 1 } { 0 } ifelse }')).toEqual([0]);
    expect(run('{ 3 3 eq { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ 3 3 ne { 1 } { 0 } ifelse }')).toEqual([0]);
    expect(run('{ 4 3 ge { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ 3 4 le { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ 4 3 gt { 1 } { 0 } ifelse }')).toEqual([1]);
  });

  it('reads and/or/xor/not as boolean logic on booleans', () => {
    expect(run('{ true false and { 1 } { 0 } ifelse }')).toEqual([0]);
    expect(run('{ true false or { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ true true xor { 1 } { 0 } ifelse }')).toEqual([0]);
    expect(run('{ true not { 1 } { 0 } ifelse }')).toEqual([0]);
  });

  it('reads the same four as bitwise on integers', () => {
    expect(run('{ 12 10 and }')).toEqual([8]);
    expect(run('{ 12 10 or }')).toEqual([14]);
    expect(run('{ 12 10 xor }')).toEqual([6]);
    expect(run('{ 5 not }')).toEqual([-6]);          // ~5
    expect(run('{ 1 3 bitshift }')).toEqual([8]);
    expect(run('{ 8 -3 bitshift }')).toEqual([1]);   // negative shifts right
  });
});

describe('type 4 stack operators', () => {
  it('dup, exch and pop', () => {
    expect(run('{ 3 dup add }')).toEqual([6]);
    expect(run('{ 3 4 exch sub }')).toEqual([1]);    // 4 3 sub
    expect(run('{ 3 4 pop }')).toEqual([3]);
  });

  it('copy duplicates the top n', () => {
    expect(run('{ 1 2 3 2 copy }', [], 5)).toEqual([1, 2, 3, 2, 3]);
    expect(run('{ 1 2 3 0 copy }', [], 3)).toEqual([1, 2, 3]);
  });

  it('index reaches n down from the top', () => {
    expect(run('{ 10 20 30 2 index }', [], 4)).toEqual([10, 20, 30, 10]);
    expect(run('{ 10 20 30 0 index }', [], 4)).toEqual([10, 20, 30, 30]);
  });

  it('roll rotates the top n by j, in both directions', () => {
    expect(run('{ 1 2 3 3 1 roll }', [], 3)).toEqual([3, 1, 2]);
    expect(run('{ 1 2 3 3 -1 roll }', [], 3)).toEqual([2, 3, 1]);
    expect(run('{ 1 2 3 3 0 roll }', [], 3)).toEqual([1, 2, 3]);
    expect(run('{ 1 2 3 3 4 roll }', [], 3)).toEqual([3, 1, 2]);   // j wraps
  });
});

describe('type 4 conditionals', () => {
  it('runs if only when the condition holds', () => {
    expect(run('{ 5 true { 1 add } if }')).toEqual([6]);
    expect(run('{ 5 false { 1 add } if }')).toEqual([5]);
  });

  it('nests ifelse', () => {
    const src = '{ dup 0 lt { pop -1 } { dup 0 eq { pop 0 } { pop 1 } ifelse } ifelse }';
    expect(run(src, [-5])).toEqual([-1]);
    expect(run(src, [0])).toEqual([0]);
    expect(run(src, [5])).toEqual([1]);
  });

  it('computes a two-argument minimum, the idiom real files use', () => {
    const min = '{ 2 copy lt { pop } { exch pop } ifelse }';
    expect(run(min, [3, 4])).toEqual([3]);
    expect(run(min, [7, 4])).toEqual([4]);
    expect(run(min, [5, 5])).toEqual([5]);
  });
});

describe('type 4 inputs and outputs', () => {
  it('starts with the inputs already on the stack, in order', () => {
    expect(run('{ sub }', [10, 3])).toEqual([7]);
  });

  it('returns the TOPMOST n values, last output on top', () => {
    expect(run('{ 1 2 3 }', [], 2)).toEqual([2, 3]);
    expect(run('{ 1 2 3 }', [], 3)).toEqual([1, 2, 3]);
  });

  it('produces a multi-output tint ramp', () => {
    // 1 in, 3 out: R = t, G = 0, B = 1 - t.
    const ramp = '{ dup 0 exch 1 exch sub }';
    expect(approx(run(ramp, [0], 3))).toEqual([0, 0, 1]);
    expect(approx(run(ramp, [1], 3))).toEqual([1, 0, 0]);
    expect(approx(run(ramp, [0.25], 3))).toEqual([0.25, 0, 0.75]);
  });
});

describe('type 4 malformed programs', () => {
  it('rejects unbalanced braces at parse time', () => {
    expect(parsePostScriptFunction(new TextEncoder().encode('{ 1 2 add'))).toBeUndefined();
    expect(parsePostScriptFunction(new TextEncoder().encode('{ 1 { 2 }'))).toBeUndefined();
  });

  it('accepts a program with no outer brace', () => {
    expect(run('3 4 add')).toEqual([7]);
  });

  it('skips an operator it does not recognise', () => {
    // The rule every non-object grammar over this tokenizer follows: damage
    // costs the bytes it touches, not the whole program.
    expect(run('{ 3 bogusoperator 4 add }')).toEqual([7]);
  });

  it('faults rather than throwing on stack underflow', () => {
    expect(run('{ add }')).toBeUndefined();
    expect(run('{ 1 add }')).toBeUndefined();
  });

  it('faults when fewer than n outputs remain', () => {
    expect(run('{ 1 }', [], 3)).toBeUndefined();
  });

  it('faults on a non-finite result rather than emitting NaN', () => {
    expect(run('{ 0 0 div }')).toBeUndefined();
    expect(run('{ 1 0 div }')).toBeUndefined();
    expect(run('{ -1 sqrt }')).toBeUndefined();
  });

  it('faults on a type error instead of coercing', () => {
    expect(run('{ true 3 add }')).toBeUndefined();
    expect(run('{ 3 { 1 } add }')).toBeUndefined();
  });

  it('is bounded on a deeply nested program', () => {
    const deep = `${'{ '.repeat(500)}1${' }'.repeat(500)}`;
    expect(parsePostScriptFunction(new TextEncoder().encode(deep))).toBeUndefined();
  });
});
