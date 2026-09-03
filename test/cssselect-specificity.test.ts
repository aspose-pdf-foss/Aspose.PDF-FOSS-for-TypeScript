import { describe, it, expect } from 'vitest';
import { parseSelectorText, specificityOf, compareSpecificity } from '../src/cssselect.js';
import type { Specificity } from '../src/cssselect.js';

const spec = (s: string): Specificity => {
  const list = parseSelectorText(s);
  if (list === null) throw new Error(`unparseable selector: ${s}`);
  return specificityOf(list[0]!);
};

describe('specificity', () => {
  it('counts an id in a, a class or attribute in b, a type in c', () => {
    expect(spec('#x')).toEqual([1, 0, 0]);
    expect(spec('.x')).toEqual([0, 1, 0]);
    expect(spec('[x]')).toEqual([0, 1, 0]);
    expect(spec('x')).toEqual([0, 0, 1]);
  });

  it('counts EACH id in a compound that names several', () => {
    // `#a#b` matches nothing, but it still weighs as two ids — which is
    // observable, because :is(#a#b, .c) takes its arguments' maximum.
    expect(spec('#a#b')).toEqual([2, 0, 0]);
  });

  it('weighs an attribute selector exactly as a class', () => {
    // Not as a type. Getting this wrong reorders a cascade plausibly.
    expect(spec('[href]')).toEqual(spec('.href'));
  });

  it('gives the universal selector and combinators nothing', () => {
    expect(spec('*')).toEqual([0, 0, 0]);
    expect(spec('a > b')).toEqual([0, 0, 2]);
    expect(spec('a b c')).toEqual([0, 0, 3]);
  });

  it('sums across every compound in a complex selector', () => {
    expect(spec('#a .b c[d]')).toEqual([1, 2, 1]);
  });

  it('compares lexicographically, so b never outweighs a', () => {
    // 10 classes must still lose to one id. This is the whole argument for a
    // tuple: a packed integer needs a documented no-carry bound to say it.
    expect(compareSpecificity(spec('#x'), spec('.a.b.c.a.b.c.a.b.c.a'))).toBeGreaterThan(0);
  });

  it('reports 0 for equal specificity, leaving source order to the caller', () => {
    expect(compareSpecificity(spec('.a'), spec('.b'))).toBe(0);
  });
});
