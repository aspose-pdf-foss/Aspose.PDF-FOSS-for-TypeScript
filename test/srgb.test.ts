import { describe, it, expect } from 'vitest';
import { srgbIcc, SRGB_N } from '../src/srgb.js';

describe('srgb profile', () => {
  it('decodes to non-empty bytes with N=3', () => {
    expect(SRGB_N).toBe(3);
    const bytes = srgbIcc();
    expect(bytes.length).toBeGreaterThan(0);
    // ICC profiles carry the color space signature 'RGB ' at offset 16.
    expect(new TextDecoder('latin1').decode(bytes.subarray(16, 20))).toBe('RGB ');
  });
});
