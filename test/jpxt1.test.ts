import { describe, it, expect } from 'vitest';
import { decodeCodeBlock } from '../src/jpxt1.js';

// Tier-1 is validated for spec-conformance end-to-end via the lossless fixture in
// test/jpx.test.ts (an exact reconstruction is impossible with a wrong Tier-1).
// These unit tests pin the degenerate contract.

describe('EBCOT Tier-1', () => {
  it('decodes an empty segment (zero passes) to all-zero coefficients', () => {
    const out = decodeCodeBlock({ width: 4, height: 4, data: new Uint8Array(0), passes: 0, zeroBitPlanes: 0, numBitPlanes: 8, sbType: 'LL' });
    expect(out.length).toBe(16);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('produces a width*height coefficient array', () => {
    const out = decodeCodeBlock({ width: 3, height: 5, data: new Uint8Array(0), passes: 0, zeroBitPlanes: 0, numBitPlanes: 8, sbType: 'HH' });
    expect(out.length).toBe(15);
  });
});
