/** Max-content (widest LINE) and min-content (widest WORD), shared by table
 *  auto-fit and a CSS float's shrink-to-fit (zch2.10). */
import { describe, it, expect } from 'vitest';
import { textExtents } from '../src/textextents.js';

/** Built rather than typed: a literal U+00A0 is indistinguishable from a space
 *  in the source, so a test written with one reads as comparing a string with
 *  itself — and passes or fails for reasons nobody can see. */
const NBSP = String.fromCharCode(0xa0);

describe('textExtents', () => {
  it('measures the widest line and the widest word of a plain string', () => {
    const one = textExtents('aa', 'Helvetica', 10);
    const two = textExtents('aa aaaa', 'Helvetica', 10);
    // One line, so longestLine covers the whole string; the widest word is the
    // four-character one.
    expect(two.longestLine).toBeGreaterThan(one.longestLine);
    expect(two.longestWord).toBeGreaterThan(one.longestWord);
    expect(two.longestWord).toBeLessThan(two.longestLine);
  });

  it('measures LINES, not the whole string, across a hard break', () => {
    const wide = textExtents('aaaaaaaa', 'Helvetica', 10);
    const split = textExtents('aaaa\naaaa', 'Helvetica', 10);
    // Measuring across the break would demand a box fitting both lines at once.
    expect(split.longestLine).toBeLessThan(wide.longestLine);
  });

  it('measures each run at its OWN font size', () => {
    const small = textExtents([{ text: 'aaaa', fontSize: 6 }], 'Helvetica', 10);
    const big = textExtents([{ text: 'aaaa', fontSize: 20 }], 'Helvetica', 10);
    expect(big.longestLine).toBeGreaterThan(small.longestLine * 2);
  });

  it('finds a word spanning a RUN boundary', () => {
    // layoutRuns breaks on the concatenated text, so `aa`+`aa` is one word.
    const joined = textExtents([{ text: 'aa' }, { text: 'aa' }], 'Helvetica', 10);
    const apart = textExtents([{ text: 'aa ' }, { text: 'aa' }], 'Helvetica', 10);
    expect(joined.longestWord).toBeGreaterThan(apart.longestWord);
  });

  it('does not break on U+00A0, which a code block paints for indentation', () => {
    const nbsp = textExtents(`aa${NBSP}aa`, 'Helvetica', 10);
    const space = textExtents('aa aa', 'Helvetica', 10);
    expect(nbsp.longestWord).toBeGreaterThan(space.longestWord);
  });

  it('returns zeros for empty content', () => {
    expect(textExtents('', 'Helvetica', 10)).toEqual({ longestLine: 0, longestWord: 0 });
    expect(textExtents([], 'Helvetica', 10)).toEqual({ longestLine: 0, longestWord: 0 });
  });
});
