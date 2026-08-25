import { describe, it, expect } from 'vitest';
import { Bio, TagTree } from '../src/jpxt2.js';

// Tier-2 packet iteration is validated end-to-end in test/jpx.test.ts. These unit
// tests pin the two primitives: the bit-stuffed reader and the quad tag-tree.

describe('Tier-2 primitives', () => {
  it('Bio reads MSB-first with 0xFF bit-unstuffing', () => {
    // 0xFF then 0x7F: after 0xFF only 7 bits of the next byte are valid (MSB stuffed).
    const bio = new Bio(Uint8Array.from([0xff, 0x7f]), 0, 2);
    const bits: number[] = [];
    for (let i = 0; i < 8; i++) bits.push(bio.getbit()); // 8 bits of 0xFF
    for (let i = 0; i < 7; i++) bits.push(bio.getbit()); // 7 valid bits of 0x7F
    expect(bits.slice(0, 8).join('')).toBe('11111111');
    expect(bits.slice(8).join('')).toBe('1111111');
  });

  it('Bio.read assembles multi-bit values MSB-first', () => {
    const bio = new Bio(Uint8Array.from([0b10110000]), 0, 1);
    expect(bio.read(4)).toBe(0b1011);
  });

  it('TagTree returns 0 when the first bit is 1 (value determined immediately)', () => {
    const tt = new TagTree(1, 1);
    const bio = new Bio(Uint8Array.from([0x80]), 0, 1); // bit '1'
    expect(tt.decode(bio, 0, 0, 5)).toBe(0);
  });

  it('TagTree accumulates increments before the terminating 1 bit', () => {
    const tt = new TagTree(1, 1);
    const bio = new Bio(Uint8Array.from([0b00100000]), 0, 1); // bits 0,0,1
    expect(tt.decode(bio, 0, 0, 5)).toBe(2);
  });

  it('TagTree stops at the threshold when no terminating 1 is read', () => {
    const tt = new TagTree(1, 1);
    const bio = new Bio(Uint8Array.from([0x00]), 0, 1); // bits 0,0,0,...
    expect(tt.decode(bio, 0, 0, 2)).toBe(2); // value hits threshold, not final
  });
});
