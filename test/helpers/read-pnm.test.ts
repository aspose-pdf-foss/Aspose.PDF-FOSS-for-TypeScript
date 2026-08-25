import { describe, it, expect } from 'vitest';
import { readPnm } from './read-pnm.js';

const bytes = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

describe('readPnm', () => {
  it('parses a P6 header and payload', () => {
    const p = readPnm(join(bytes('P6\n2 1\n255\n'), Uint8Array.from([1, 2, 3, 4, 5, 6])));
    expect(p.magic).toBe('P6');
    expect(p.width).toBe(2);
    expect(p.height).toBe(1);
    expect(p.max).toBe(255);
    expect([...p.data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('parses a P5 grayscale header and payload', () => {
    const p = readPnm(join(bytes('P5\n3 1\n255\n'), Uint8Array.from([7, 8, 9])));
    expect(p.magic).toBe('P5');
    expect(p.width).toBe(3);
    expect([...p.data]).toEqual([7, 8, 9]);
  });

  it('accepts arbitrary whitespace between header fields', () => {
    const p = readPnm(join(bytes('P6  2\t1\n\n255 '), Uint8Array.from([1, 2, 3, 4, 5, 6])));
    expect(p.width).toBe(2);
    expect([...p.data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('skips comments anywhere in the header', () => {
    const p = readPnm(join(bytes('P6\n# CREATOR: cjpeg\n2 1\n# another\n255\n'), Uint8Array.from([1, 2, 3, 4, 5, 6])));
    expect(p.width).toBe(2);
    expect([...p.data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('does not treat a 0x23 byte in the payload as a comment', () => {
    // 0x23 is '#'. It is only a comment in the header; payload is opaque.
    const p = readPnm(join(bytes('P6\n1 1\n255\n'), Uint8Array.from([0x23, 0x23, 0x23])));
    expect([...p.data]).toEqual([0x23, 0x23, 0x23]);
  });

  it('throws on 16-bit maxval', () => {
    expect(() => readPnm(join(bytes('P5\n1 1\n65535\n'), Uint8Array.from([0, 0]))))
      .toThrow(/16-bit/);
  });

  it('throws on a short payload', () => {
    expect(() => readPnm(join(bytes('P6\n2 1\n255\n'), Uint8Array.from([1, 2, 3]))))
      .toThrow(/short payload/);
  });

  it('throws on unsupported magic', () => {
    expect(() => readPnm(bytes('P3\n1 1\n255\n0 0 0\n'))).toThrow(/unsupported magic/);
  });
});
