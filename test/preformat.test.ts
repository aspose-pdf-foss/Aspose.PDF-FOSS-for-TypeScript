import { describe, it, expect } from 'vitest';
import { preformat, expandTabs, NBSP } from '../src/preformat.js';

describe('preformat', () => {
  it('protects LEADING indentation with no-break spaces', () => {
    // layoutRuns collapses runs of spaces, which is right for prose and fatal
    // to indentation. U+00A0 costs nothing: WinAnsiEncoding names that code
    // /space and its AFM advance is identical.
    expect(preformat('  a', 4)).toBe(`${NBSP}${NBSP}a`);
  });

  it('protects an INTERIOR run of two or more spaces', () => {
    expect(preformat('a  b', 4)).toBe(`a${NBSP}${NBSP}b`);
  });

  it('leaves a SINGLE interior space alone', () => {
    // One space is an ordinary word separator and must stay breakable, or a
    // long preformatted line could never wrap at all.
    expect(preformat('a b', 4)).toBe('a b');
  });

  it('keeps newlines, so each source line stays its own unit', () => {
    expect(preformat('a\n  b', 4)).toBe(`a\n${NBSP}${NBSP}b`);
  });

  it('expands a tab to the next tab stop, not to a fixed width', () => {
    expect(expandTabs('\ta', 4)).toBe(`${NBSP.repeat(4)}a`);
    expect(expandTabs('ab\tc', 4)).toBe(`ab${NBSP.repeat(2)}c`);
    expect(expandTabs('abcd\te', 4)).toBe(`abcd${NBSP.repeat(4)}e`);
  });

  it('expands a tab directly to no-break spaces', () => {
    // A tab is indentation BY INTENT, so a one-column tab must not be left
    // unprotected by the two-or-more rule below it.
    expect(expandTabs('abc\td', 4)).toBe(`abc${NBSP}d`);
  });

  it('is empty-safe', () => {
    expect(preformat('', 4)).toBe('');
    expect(expandTabs('', 4)).toBe('');
  });
});
