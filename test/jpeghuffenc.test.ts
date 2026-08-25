import { describe, it, expect } from 'vitest';
import {
  BitWriter, buildHuffTable, buildOptimalHuffTable,
  STD_DC_LUMA, STD_AC_LUMA, STD_DC_CHROMA, STD_AC_CHROMA,
} from '../src/jpeghuffenc.js';

describe('BitWriter', () => {
  it('packs bits MSB-first', () => {
    const bw = new BitWriter();
    bw.put(0b101, 3);
    bw.put(0b11010, 5);
    expect(bw.bytes).toEqual([0b10111010]);
  });

  it('stuffs a zero byte after every 0xFF', () => {
    const bw = new BitWriter();
    bw.put(0xff, 8);
    expect(bw.bytes).toEqual([0xff, 0x00]);
  });

  it('pads the final partial byte with 1-bits on flush', () => {
    const bw = new BitWriter();
    bw.put(0b1, 1);
    bw.flush();
    expect(bw.bytes).toEqual([0b11111111, 0x00]); // padding makes 0xFF, which is then stuffed
  });

  it('flush on a byte boundary emits nothing extra', () => {
    const bw = new BitWriter();
    bw.put(0b10101010, 8);
    bw.flush();
    expect(bw.bytes).toEqual([0b10101010]);
  });
});

describe('buildHuffTable', () => {
  it('assigns canonical codes in (length, order) sequence', () => {
    // 2 codes of length 2, 1 of length 3 -> 00, 01, 100
    const t = buildHuffTable([0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [7, 8, 9]);
    expect(t.enc.get(7)).toEqual({ code: 0b00, len: 2 });
    expect(t.enc.get(8)).toEqual({ code: 0b01, len: 2 });
    expect(t.enc.get(9)).toEqual({ code: 0b100, len: 3 });
  });
});

const ALL_STD = [
  ['STD_DC_LUMA', STD_DC_LUMA], ['STD_AC_LUMA', STD_AC_LUMA],
  ['STD_DC_CHROMA', STD_DC_CHROMA], ['STD_AC_CHROMA', STD_AC_CHROMA],
] as const;

describe('Annex K standard tables', () => {
  for (const [label, t] of ALL_STD) {
    it(`${label}: bits sums to vals.length, and bits has 16 entries`, () => {
      expect(t.bits.length).toBe(16);
      expect(t.bits.reduce((a, b) => a + b, 0)).toBe(t.vals.length);
      expect(t.enc.size).toBe(t.vals.length);
    });

    it(`${label}: is prefix-free and avoids the all-ones codeword`, () => {
      const seen: { code: number; len: number }[] = [];
      for (const c of t.enc.values()) {
        // No code may be an all-ones pattern (reserved as a decoder sentinel).
        expect(c.code).not.toBe((1 << c.len) - 1);
        for (const p of seen) {
          const shorter = p.len <= c.len ? p : c;
          const longer = p.len <= c.len ? c : p;
          const prefix = longer.code >>> (longer.len - shorter.len);
          expect(prefix).not.toBe(shorter.code);
        }
        seen.push(c);
      }
    });
  }
});

const freqOf = (counts: Record<number, number>): Int32Array => {
  const f = new Int32Array(257);
  for (const [s, n] of Object.entries(counts)) f[Number(s)] = n;
  return f;
};

const isPrefixFree = (t: { enc: Map<number, { code: number; len: number }> }): boolean => {
  const all = [...t.enc.values()];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    const shorter = a.len <= b.len ? a : b;
    const longer = a.len <= b.len ? b : a;
    if ((longer.code >>> (longer.len - shorter.len)) === shorter.code) return false;
  }
  return true;
};

describe('buildOptimalHuffTable', () => {
  it('gives a more frequent symbol a code no longer than a rarer one', () => {
    const t = buildOptimalHuffTable(freqOf({ 1: 1000, 2: 100, 3: 10, 4: 1 }));
    const len = (s: number) => t.enc.get(s)!.len;
    expect(len(1)).toBeLessThanOrEqual(len(2));
    expect(len(2)).toBeLessThanOrEqual(len(3));
    expect(len(3)).toBeLessThanOrEqual(len(4));
  });

  it('emits only symbols with a nonzero count, and never the phantom', () => {
    const t = buildOptimalHuffTable(freqOf({ 5: 3, 9: 7 }));
    expect(new Set(t.vals)).toEqual(new Set([5, 9]));
    expect(t.vals).not.toContain(256);
    expect(t.bits.reduce((a, b) => a + b, 0)).toBe(t.vals.length);
  });

  it('is prefix-free and never assigns the all-ones codeword', () => {
    const t = buildOptimalHuffTable(freqOf({ 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 }));
    expect(isPrefixFree(t)).toBe(true);
    for (const c of t.enc.values()) expect(c.code).not.toBe((1 << c.len) - 1);
  });

  it('limits code length to 16 bits on a Fibonacci histogram', () => {
    // Fibonacci frequencies are the classic worst case: an unconstrained build
    // produces a degenerate ~n-deep tree, well past 16 bits.
    const f = new Int32Array(257);
    let a = 1, b = 1;
    for (let s = 0; s < 40; s++) { f[s] = a; const n = a + b; a = b; b = n; }
    const t = buildOptimalHuffTable(f);
    for (const c of t.enc.values()) {
      expect(c.len).toBeGreaterThanOrEqual(1);
      expect(c.len).toBeLessThanOrEqual(16);
    }
    expect(t.bits.length).toBe(16);
    expect(t.bits.reduce((x, y) => x + y, 0)).toBe(t.vals.length);
    expect(isPrefixFree(t)).toBe(true);
  });

  it('handles a single-symbol histogram', () => {
    const t = buildOptimalHuffTable(freqOf({ 42: 9 }));
    expect(t.vals).toEqual([42]);
    expect(t.enc.get(42)!.len).toBeGreaterThanOrEqual(1);
    expect(t.enc.get(42)!.code).not.toBe((1 << t.enc.get(42)!.len) - 1);
  });

  it('does not mutate the caller frequency array', () => {
    const f = freqOf({ 1: 5, 2: 4 });
    const before = [...f];
    buildOptimalHuffTable(f);
    expect([...f]).toEqual(before);
  });
});
