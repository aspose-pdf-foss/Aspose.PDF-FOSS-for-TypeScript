import { describe, it, expect } from 'vitest';
import { layoutText, FontDriver } from '../src/layout.js';

// 10pt per code point; encode/probe count code points (monospace stub).
const stub: FontDriver = {
  measure: (t) => [...t].length * 10,
  encode: (t) => new Uint8Array([...t].length),
  probe: (t) => [...t].length,
};

describe('layoutText — UAX #14 over-wide tokens', () => {
  it('wraps a space-less CJK run at ideograph boundaries', () => {
    // box width 35 → 3 chars per line (30 ≤ 35 < 40).
    const { lines } = layoutText('中文字符测试', stub, 10, 35, 1000, 12);
    expect(lines.map((l) => l.text)).toEqual(['中文字', '符测试']);
  });

  it('does NOT insert a space when reflowing a CJK break (remainder)', () => {
    // height fits 1 line only → remainder is the rest with NO separator.
    const { lines, remainder } = layoutText('中文字符', stub, 10, 25, 12, 12);
    expect(lines.map((l) => l.text)).toEqual(['中文']);
    expect(remainder).toBe('字符'); // no space injected between 文 and 字
  });

  it('leaves normal Latin word-wrap byte-identical (spaces only)', () => {
    const { lines, remainder } = layoutText('alpha beta gamma', stub, 10, 100, 1000, 12);
    // 'alpha beta' = 10 chars = 100 ≤ 100; + ' gamma' overflows → wrap.
    expect(lines.map((l) => l.text)).toEqual(['alpha beta', 'gamma']);
    expect(remainder).toBe('');
  });

  it('does not sub-break a hyphenated word that already fits', () => {
    const { lines } = layoutText('well-known', stub, 10, 200, 1000, 12);
    expect(lines.map((l) => l.text)).toEqual(['well-known']); // untouched
  });

  it('breaks an over-wide hyphenated word at the hyphen (improvement over overflow)', () => {
    // 'well-known' = 10 chars = 100pt; box 60 → 'well-'(50) fits, 'known' next.
    const { lines } = layoutText('well-known', stub, 10, 60, 1000, 12);
    expect(lines.map((l) => l.text)).toEqual(['well-', 'known']);
  });
});
