import { describe, it, expect } from 'vitest';
import { LB, lineBreak } from '../src/unicode-data.js';
import { lineBreakOpportunities, LBRK } from '../src/linebreak.js';

// Break BEFORE index i? (true = a break is allowed/mandatory before codes[i]).
function breaksBefore(codes: number[]): boolean[] {
  return [...lineBreakOpportunities(codes)].map((v) => v !== LBRK.PROHIBITED);
}
const cp = (s: string) => [...s].map((c) => c.codePointAt(0)!);

describe('lineBreak() accessor', () => {
  it('classifies representative code points', () => {
    expect(lineBreak(0x0041)).toBe(LB.AL);   // 'A' = Alphabetic
    expect(lineBreak(0x0020)).toBe(LB.SP);   // SPACE
    expect(lineBreak(0x000A)).toBe(LB.LF);   // LINE FEED
    expect(lineBreak(0x2014)).toBe(LB.B2);   // EM DASH = B2
    expect(lineBreak(0x4E00)).toBe(LB.ID);   // CJK ideograph = ID
    expect(lineBreak(0x3002)).toBe(LB.CL);   // IDEOGRAPHIC FULL STOP = CL
    expect(lineBreak(0x00A0)).toBe(LB.GL);   // NBSP = GL (non-breaking)
    expect(lineBreak(0x2060)).toBe(LB.WJ);   // WORD JOINER
  });
});

describe('lineBreakOpportunities — rules', () => {
  it('LB2: never breaks before the first character', () => {
    expect(breaksBefore(cp('AB'))[0]).toBe(false);
  });
  it('breaks after a space (LB7/LB18), not before it', () => {
    expect(breaksBefore(cp('A B'))).toEqual([false, false, true]);
  });
  it('LB4/LB5: mandatory break after LF', () => {
    const r = lineBreakOpportunities([0x41, 0x0a, 0x42]); // A \n B
    expect(r[2]).toBe(LBRK.MANDATORY);
  });
  it('CJK ideographs break between each other (ID)', () => {
    expect(breaksBefore(cp('中文'))).toEqual([false, true]);
  });
  it('LB13: no break before closing punctuation (CL)', () => {
    expect(breaksBefore(cp('中。'))).toEqual([false, false]); // 。 = U+3002 CL
  });
  it('LB12a/GL: no break around a non-breaking space', () => {
    expect(breaksBefore([0x41, 0x00a0, 0x42])).toEqual([false, false, false]);
  });
  it('LB11/WJ: no break around a word joiner', () => {
    expect(breaksBefore([0x41, 0x2060, 0x42])).toEqual([false, false, false]);
  });
  it('LB21/HY: break after a hyphen, not before', () => {
    expect(breaksBefore(cp('a-b'))).toEqual([false, false, true]);
  });
  it('LB30a: regional-indicator pairs stay together, break between pairs', () => {
    const ri = 0x1f1e6;
    expect(breaksBefore([ri, ri, ri, ri])).toEqual([false, false, true, false]);
  });
});
