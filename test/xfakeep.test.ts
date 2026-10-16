import { describe, it, expect } from 'vitest';
import { adheres, nextAdhering, intactSplits } from '../src/xfakeep.js';
import type { LayoutNode } from '../src/xfaflow.js';

const n = (label: string, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: {}, children: [], ...extra });

describe('adheres (164g.14 R1, R7)', () => {
  it('holds when the first states next or the second previous (t55, t56)', () => {
    expect(adheres(n('a', { keep: { next: 'contentArea' } }), n('b'))).toBe(true);
    expect(adheres(n('a'), n('b', { keep: { previous: 'contentArea' } }))).toBe(true);
    expect(adheres(n('a'), n('b'))).toBe(false);
  });
  it('reads pageArea as no adhesion (t64)', () => {
    expect(adheres(n('a', { keep: { next: 'pageArea' } }), n('b', { keep: { previous: 'pageArea' } }))).toBe(false);
  });
  it('ignores next on the second and previous on the first', () => {
    expect(adheres(n('a', { keep: { previous: 'contentArea' } }), n('b', { keep: { next: 'contentArea' } }))).toBe(false);
  });
  it('matches the enumeration exactly', () => {
    expect(adheres(n('a', { keep: { next: 'ContentArea' } }), n('b'))).toBe(false);
    expect(adheres(n('a', { keep: { next: ' contentArea' } }), n('b'))).toBe(false);
  });
});

describe('nextAdhering (R6)', () => {
  const k = { keep: { next: 'contentArea' } };
  it('skips a hidden or inactive sibling (t63)', () => {
    const s = [n('C', k), n('H', { presence: 'hidden' }), n('I', { presence: 'inactive' }), n('D')];
    expect(nextAdhering(s, 0)).toBe(3);
  });
  it('answers undefined for the last visible sibling and for no adhesion', () => {
    expect(nextAdhering([n('C', k), n('H', { presence: 'hidden' })], 0)).toBeUndefined();
    expect(nextAdhering([n('C'), n('D')], 0)).toBeUndefined();
  });
  it('a visible but invisible sibling is adjacent (it takes space)', () => {
    expect(nextAdhering([n('C', k), n('V', { presence: 'invisible' }), n('D')], 0)).toBe(1);
  });
});

describe('intactSplits (R8)', () => {
  it('none and absent split; contentArea does not', () => {
    expect(intactSplits(n('t', { layout: 'tb' }))).toBe(true);
    expect(intactSplits(n('t', { layout: 'tb', keep: { intact: 'none' } }))).toBe(true);
    expect(intactSplits(n('t', { layout: 'tb', keep: { intact: 'contentArea' } }))).toBe(false);
  });
  it('pageArea splits a flowed subform (t66-t68) and not a positioned one (t71)', () => {
    for (const layout of ['tb', 'lr-tb', 'table'])
      expect(intactSplits(n('t', { layout, keep: { intact: 'pageArea' } }))).toBe(true);
    expect(intactSplits(n('p', { layout: 'position', keep: { intact: 'pageArea' } }))).toBe(false);
    expect(intactSplits(n('p', { keep: { intact: 'pageArea' } }))).toBe(false);
  });
});
