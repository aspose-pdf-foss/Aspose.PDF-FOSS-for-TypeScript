import { describe, it, expect } from 'vitest';
import { unitLength } from '../src/svgtransform.js';

describe('unitLength', () => {
  it('returns the default for an absent value', () => {
    expect(unitLength(undefined, 7, true, 200)).toBe(7);
  });

  it('returns the default for an unparseable value', () => {
    expect(unitLength('wide', 7, false, 200)).toBe(7);
  });

  it('takes a bare number literally under either unit', () => {
    expect(unitLength('12', 0, true, 200)).toBe(12);
    expect(unitLength('12', 0, false, 200)).toBe(12);
  });

  it('makes a percentage a fraction under objectBoundingBox', () => {
    expect(unitLength('120%', 0, true, 200)).toBeCloseTo(1.2);
  });

  it('resolves a percentage against the span under userSpaceOnUse', () => {
    expect(unitLength('120%', 0, false, 200)).toBeCloseTo(240);
  });

  it('handles a negative percentage, which the mask defaults rely on', () => {
    expect(unitLength('-10%', 0, true, 200)).toBeCloseTo(-0.1);
    expect(unitLength('-10%', 0, false, 200)).toBeCloseTo(-20);
  });

  it('tolerates surrounding whitespace', () => {
    expect(unitLength('  50% ', 0, false, 200)).toBeCloseTo(100);
  });
});
