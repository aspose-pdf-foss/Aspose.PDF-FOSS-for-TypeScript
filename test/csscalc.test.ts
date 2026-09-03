import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import { mathValueOf, evalNode } from '../src/csscalc.js';
import type { LengthContext, CalcNode } from '../src/csscalc.js';

const CTX: LengthContext = { fontSize: 20, rootFontSize: 16 };

/** The one component value a math expression is. */
const M = (s: string) => mathValueOf(parseComponentValueList(s)[0]!, CTX);

describe('calc(), the linear form', () => {
  it('adds two lengths', () => {
    expect(M('calc(1px + 2px)')).toEqual({ lp: { kind: 'lin', px: 3, pct: 0 } });
  });

  it('subtracts', () => {
    expect(M('calc(10px - 4px)')).toEqual({ lp: { kind: 'lin', px: 6, pct: 0 } });
  });

  it('multiplies by a number on either side', () => {
    expect(M('calc(2 * 3px)')).toEqual({ lp: { kind: 'lin', px: 6, pct: 0 } });
    expect(M('calc(3px * 2)')).toEqual({ lp: { kind: 'lin', px: 6, pct: 0 } });
  });

  it('divides by a number', () => {
    expect(M('calc(10px / 4)')).toEqual({ lp: { kind: 'lin', px: 2.5, pct: 0 } });
  });

  it('binds * and / tighter than + and -', () => {
    expect(M('calc(1px + 2 * 3px)')).toEqual({ lp: { kind: 'lin', px: 7, pct: 0 } });
  });

  it('parenthesises', () => {
    expect(M('calc((1px + 2px) * 3)')).toEqual({ lp: { kind: 'lin', px: 9, pct: 0 } });
  });

  it('nests a calc() inside itself', () => {
    expect(M('calc(1px + calc(2px * 2))')).toEqual({ lp: { kind: 'lin', px: 5, pct: 0 } });
  });

  it('keeps a percentage as a percentage, alongside px', () => {
    // CSS Values 4 §10.9: a length-percentage math function reduces to
    // `calc(A + B%)`. Both halves ride together and the basis is the
    // caller's, which is why nothing here resolves one.
    expect(M('calc(100% - 20px)')).toEqual({ lp: { kind: 'lin', px: -20, pct: 100 } });
  });

  it('scales a percentage', () => {
    expect(M('calc(50% * 2)')).toEqual({ lp: { kind: 'lin', px: 0, pct: 100 } });
  });

  it('resolves every unit lengthOf resolves, through one owner', () => {
    expect(M('calc(1em + 1rem)')).toEqual({ lp: { kind: 'lin', px: 36, pct: 0 } });
    expect(M('calc(1in - 24pt)')).toEqual({ lp: { kind: 'lin', px: 64, pct: 0 } });
  });

  it('folds a pure NUMBER expression to a number', () => {
    expect(M('calc(2 * 3 + 1)')).toEqual({ num: 7 });
  });

  it('is case-insensitive in the function name', () => {
    expect(M('CALC(1px + 1px)')).toEqual({ lp: { kind: 'lin', px: 2, pct: 0 } });
  });
});

describe('calc(), what it refuses', () => {
  it('refuses a NAME that is not a math function', () => {
    expect(M('foo(1px + 1px)')).toBeUndefined();
    expect(M('1px')).toBeUndefined();
  });

  it('refuses an empty expression', () => {
    expect(M('calc()')).toBeUndefined();
  });

  it('refuses two values with no operator between them', () => {
    expect(M('calc(1px 2px)')).toBeUndefined();
  });

  // CSS requires whitespace on both sides of + and -, and FOUR separate
  // mechanisms enforce it. One fixture would leave three of them unmeasured,
  // so each spelling gets its own case — see the note on parseSum.

  it('refuses an unspaced - that the tokenizer swallowed into the UNIT', () => {
    // `-` is a name character, so `1px-2px` is a single dimension whose unit
    // is the nonsense `px-2px`. No operator is ever seen; the unit table is
    // what refuses it.
    expect(M('calc(1px-2px)')).toBeUndefined();
  });

  it('refuses an unspaced - that the tokenizer swallowed into the NUMBER', () => {
    // With a space before it, `-2px` is a dimension carrying its own sign, so
    // this is two values and no operator.
    expect(M('calc(1px -2px)')).toBeUndefined();
  });

  it('refuses a real + delim with no whitespace BEFORE it', () => {
    expect(M('calc(1px+ 2px)')).toBeUndefined();
    expect(M('calc(1px- 2px)')).toBeUndefined();
  });

  it('refuses a real + delim with no whitespace AFTER it', () => {
    // The only spelling the trailing-whitespace check catches: every other
    // unspaced form has already been refused by one of the three above.
    expect(M('calc(1px +(2px))')).toBeUndefined();
  });

  it('needs no whitespace around * and /', () => {
    expect(M('calc(2*3px)')).toEqual({ lp: { kind: 'lin', px: 6, pct: 0 } });
    expect(M('calc(6px/2)')).toEqual({ lp: { kind: 'lin', px: 3, pct: 0 } });
  });

  it('refuses a trailing operator', () => {
    expect(M('calc(1px +)')).toBeUndefined();
    expect(M('calc(1px *)')).toBeUndefined();
  });

  it('refuses a unit it has no viewport for', () => {
    expect(M('calc(1vw + 1px)')).toBeUndefined();
  });

  it('refuses a value that is not a number, dimension or percentage', () => {
    expect(M('calc(red + 1px)')).toBeUndefined();
    expect(M('calc("a" + 1px)')).toBeUndefined();
  });
});

describe('calc(), the type rules', () => {
  it('refuses adding a number to a length', () => {
    // Both directions: the check is on the pair, not on the left operand.
    expect(M('calc(1px + 2)')).toBeUndefined();
    expect(M('calc(2 + 1px)')).toBeUndefined();
  });

  it('adds a percentage to a length, which is the whole point', () => {
    expect(M('calc(10% + 1px)')).toEqual({ lp: { kind: 'lin', px: 1, pct: 10 } });
  });

  it('refuses multiplying two lengths', () => {
    // px * px is an area, which is not a type any property here takes.
    expect(M('calc(2px * 3px)')).toBeUndefined();
    expect(M('calc(50% * 2px)')).toBeUndefined();
  });

  it('refuses dividing by anything but a number', () => {
    expect(M('calc(10px / 2px)')).toBeUndefined();
    expect(M('calc(10px / 50%)')).toBeUndefined();
  });

  it('refuses division by zero, DIVERGING from Chrome on purpose', () => {
    // A divisor is number-typed, and by the rules above a number-typed
    // subtree can hold no percentage — so it is fully known here and the
    // decision lands at parse time rather than at resolve time.
    //
    // The oracle found this and we did not follow it. CSS Values 3 made
    // division by zero invalid; Values 4 §10.9 makes it infinity, clamped by
    // §10.12's range checking, and Chrome/152 agrees — `margin-top:
    // calc(10px / 0)` computes there to 33554432px, which is 2^25. We refuse,
    // because an infinite length reaches stamp.ts and throws on a non-finite
    // rect, and matching Chrome would mean adopting the clamp too for an
    // expression no document means. A refused declaration falls back to the
    // initial or inherited value, which renders.
    //
    // Recorded here rather than left in the corpus: the case is OUT of
    // test/fixtures/css-cascade/goldens.json, because that corpus runs whole
    // with no allowlist and that is worth more than one extra fixture.
    expect(M('calc(10px / 0)')).toBeUndefined();
    expect(M('calc(10px / (2 - 2))')).toBeUndefined();
  });
});

describe('min(), max() and clamp()', () => {
  it('folds a percentage-FREE comparison to a plain length', () => {
    // No percentage means the winner cannot depend on the basis, so the tree
    // is settled here and no consumer ever sees a `fn` node for it.
    expect(M('min(3px, 1px, 2px)')).toEqual({ lp: { kind: 'lin', px: 1, pct: 0 } });
    expect(M('max(3px, 1px, 2px)')).toEqual({ lp: { kind: 'lin', px: 3, pct: 0 } });
    expect(M('clamp(2px, 1px, 9px)')).toEqual({ lp: { kind: 'lin', px: 2, pct: 0 } });
  });

  it('folds a NUMBER comparison to a number', () => {
    expect(M('min(3, 1, 2)')).toEqual({ num: 1 });
    expect(M('clamp(1, 5, 3)')).toEqual({ num: 3 });
  });

  it('RETAINS a percentage-bearing comparison, which is why the tree exists', () => {
    expect(M('min(50%, 100px)')).toEqual({
      lp: {
        kind: 'fn',
        fn: 'min',
        args: [{ kind: 'lin', px: 0, pct: 50 }, { kind: 'lin', px: 100, pct: 0 }],
      },
    });
  });

  it('resolves a retained comparison against a basis, both ways round', () => {
    // The whole reason it could not fold: the answer changes with the basis.
    const v = M('min(50%, 100px)') as { lp: CalcNode };
    expect(evalNode(v.lp, 100)).toBe(50);
    expect(evalNode(v.lp, 1000)).toBe(100);
  });

  it('lets the LOWER bound win an inverted clamp()', () => {
    // clamp(min, val, max) is max(min, min(val, max)), so when min > max the
    // minimum wins (CSS Values 4 §10.5). A fixture whose bounds are the right
    // way round cannot see this: both readings agree everywhere else.
    expect(M('clamp(10px, 5px, 2px)')).toEqual({ lp: { kind: 'lin', px: 10, pct: 0 } });
  });

  it('clamps against a basis', () => {
    const v = M('clamp(10px, 50%, 40px)') as { lp: CalcNode };
    expect(evalNode(v.lp, 10)).toBe(10);
    expect(evalNode(v.lp, 60)).toBe(30);
    expect(evalNode(v.lp, 200)).toBe(40);
  });

  it('lets an outer calc() carry a retained comparison', () => {
    // A sum with a non-linear operand cannot fold either, so the sum node is
    // built rather than the expression refused.
    const v = M('calc(1px + min(50%, 100px))') as { lp: CalcNode };
    expect(v.lp.kind).toBe('sum');
    expect(evalNode(v.lp, 100)).toBe(51);
    expect(evalNode(v.lp, 1000)).toBe(101);
  });

  it('lets an outer calc() SCALE a retained comparison', () => {
    const v = M('calc(2 * min(50%, 100px))') as { lp: CalcNode };
    expect(v.lp.kind).toBe('scale');
    expect(evalNode(v.lp, 100)).toBe(100);
  });

  it('nests comparisons', () => {
    expect(M('max(1px, min(4px, 2px))')).toEqual({ lp: { kind: 'lin', px: 2, pct: 0 } });
  });

  it('takes one argument, and any number above one', () => {
    expect(M('min(5px)')).toEqual({ lp: { kind: 'lin', px: 5, pct: 0 } });
    expect(M('max(1px, 2px, 3px, 4px)')).toEqual({ lp: { kind: 'lin', px: 4, pct: 0 } });
  });

  it('refuses a clamp() that is not exactly three arguments', () => {
    expect(M('clamp(1px, 2px)')).toBeUndefined();
    expect(M('clamp(1px, 2px, 3px, 4px)')).toBeUndefined();
  });

  it('refuses a MIXED argument list', () => {
    // A number and a length are different types, so there is no comparison
    // to make — the same rule `+` follows.
    expect(M('min(1px, 2)')).toBeUndefined();
  });

  it('refuses an empty argument', () => {
    expect(M('min()')).toBeUndefined();
    expect(M('min(1px,)')).toBeUndefined();
  });
});
