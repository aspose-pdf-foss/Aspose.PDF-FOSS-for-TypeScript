import { describe, it, expect } from 'vitest';
import { BitWriter, BitReader } from '../src/linearize.js';

describe('BitWriter / BitReader — MSB-first round trip', () => {
  it('packs and unpacks fields of mixed widths', () => {
    const w = new BitWriter();
    const fields: [number, number][] = [
      [1, 1], [0, 1], [5, 3], [255, 8], [0, 0], [1023, 10], [0x1234, 16], [7, 4],
    ];
    for (const [v, bits] of fields) w.write(v, bits);
    const data = w.finish();
    const r = new BitReader(data);
    for (const [v, bits] of fields) expect(r.read(bits)).toBe(v);
  });

  it('writes MSB-first within a byte', () => {
    const w = new BitWriter();
    w.write(0b101, 3);     // top three bits of the first byte
    w.write(0, 5);
    expect(w.finish()[0]).toBe(0b10100000);
  });

  it('pads the final partial byte with zero bits', () => {
    const w = new BitWriter();
    w.write(0b1, 1);
    const out = w.finish();
    expect(out.length).toBe(1);
    expect(out[0]).toBe(0b10000000);
  });

  it('handles 32-bit values without sign issues', () => {
    const w = new BitWriter();
    w.write(0xffffffff & 0xffffffff, 32); // 0xFFFFFFFF
    w.write(0x80000000, 32);
    const r = new BitReader(w.finish());
    expect(r.read(32)).toBe(0xffffffff);
    expect(r.read(32)).toBe(0x80000000);
  });
});
