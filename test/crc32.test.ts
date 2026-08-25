import { describe, it, expect } from 'vitest';
import { crc32 } from '../src/crc32.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('crc32', () => {
  // Published vectors. These are the anchor OUTSIDE our own code: a reader and
  // a writer that share a wrong initial or final XOR agree with each other and
  // with nothing else, and a wrong CRC in a ZIP is not a crash — it is an
  // archive some tools accept and others reject.
  it('matches the published values for known inputs', () => {
    expect(crc32(bytes(''))).toBe(0x00000000);
    expect(crc32(bytes('a'))).toBe(0xe8b7be43);
    expect(crc32(bytes('abc'))).toBe(0x352441c2);
    expect(crc32(bytes('hello'))).toBe(0x3610a686);
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
  });

  it('returns an unsigned value, never a negative int32', () => {
    // 'a' is 0xE8B7BE43, whose top bit is set — the case a missing >>> 0 gets
    // wrong, and one that a self-consistent round trip would never reveal.
    expect(crc32(bytes('a'))).toBeGreaterThan(0);
  });
});
