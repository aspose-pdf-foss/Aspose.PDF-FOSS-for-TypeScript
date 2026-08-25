import { describe, it, expect } from 'vitest';
import { layoutText, winAnsiDriver } from '../src/layout.js';

const CR = winAnsiDriver('Courier');

// Courier is monospaced: every glyph advances 600/1000 * fontSize.
// At fontSize 12 that is 7.2 pt per character (spaces included).
const SIZE = 12;
const CW = 7.2; // Courier char width at size 12
const LEADING = 14.4;
const BIG = 10_000; // effectively unlimited box height

const texts = (r: { lines: { text: string }[] }) => r.lines.map((l) => l.text);

describe('layoutText greedy word-wrap', () => {
  it('wraps space-separated words at the box width', () => {
    // "aaa bbb" = 7 chars = 50.4; "aaa bbb ccc" = 11 chars = 79.2; box 60 fits 2 words
    const r = layoutText('aaa bbb ccc', CR, SIZE, 60, BIG, LEADING);
    expect(texts(r)).toEqual(['aaa bbb', 'ccc']);
    expect(r.remainder).toBe('');
  });

  it('measures each laid line width with the font metrics', () => {
    const r = layoutText('aaa bbb ccc', CR, SIZE, 60, BIG, LEADING);
    expect(r.lines[0].width).toBeCloseTo(7 * CW, 6); // "aaa bbb"
    expect(r.lines[1].width).toBeCloseTo(3 * CW, 6); // "ccc"
  });

  it('marks only paragraph-final lines hardBreak (soft wraps are false)', () => {
    const r = layoutText('aaa bbb ccc', CR, SIZE, 60, BIG, LEADING);
    expect(r.lines[0].hardBreak).toBe(false);
    expect(r.lines[1].hardBreak).toBe(true);
  });

  it('encodes each line to WinAnsi bytes', () => {
    const r = layoutText('aaa bbb ccc', CR, SIZE, 60, BIG, LEADING);
    expect(new TextDecoder('latin1').decode(r.lines[0].bytes)).toBe('aaa bbb');
  });
});

describe('layoutText explicit newlines', () => {
  it('forces a break at every \\n and marks both lines hardBreak', () => {
    const r = layoutText('aaa\nbbb', CR, SIZE, BIG, BIG, LEADING);
    expect(texts(r)).toEqual(['aaa', 'bbb']);
    expect(r.lines.map((l) => l.hardBreak)).toEqual([true, true]);
    expect(r.remainder).toBe('');
  });

  it('preserves a blank line from consecutive newlines', () => {
    const r = layoutText('a\n\nb', CR, SIZE, BIG, BIG, LEADING);
    expect(texts(r)).toEqual(['a', '', 'b']);
  });
});

describe('layoutText over-wide word', () => {
  it('emits a word wider than the box alone, overflowing horizontally', () => {
    // "supercalifragilistic" = 20 chars = 144 pt, box width only 50
    const r = layoutText('aa supercalifragilistic', CR, SIZE, 50, BIG, LEADING);
    expect(texts(r)).toEqual(['aa', 'supercalifragilistic']);
    expect(r.lines[1].width).toBeCloseTo(20 * CW, 6);
    expect(r.lines[1].width).toBeGreaterThan(50);
  });
});

describe('layoutText vertical fit', () => {
  it('stops once the next line would cross the box bottom, returning the remainder', () => {
    // wraps to ["aaa bbb", "ccc"]; height fits exactly one line
    const r = layoutText('aaa bbb ccc', CR, SIZE, 60, LEADING, LEADING);
    expect(texts(r)).toEqual(['aaa bbb']);
    expect(r.remainder).toBe('ccc');
  });

  it('emits nothing and returns the whole text when one line cannot fit', () => {
    const r = layoutText('aaa bbb ccc', CR, SIZE, 60, LEADING - 0.1, LEADING);
    expect(r.lines).toHaveLength(0);
    expect(r.remainder).toBe('aaa bbb ccc'); // whole text returned, reflows identically
  });

  it('forces the last emitted line hardBreak even mid-paragraph', () => {
    const r = layoutText('aaa bbb ccc', CR, SIZE, 60, LEADING, LEADING);
    expect(r.lines[0].hardBreak).toBe(true); // soft wrap, but it is the last visible line
  });
});

describe('layoutText remainder re-flow', () => {
  it('re-flowing the remainder reconstructs the full set of lines', () => {
    const text = 'one two three four five\nsecond paragraph here';
    const width = 80; // forces wrapping within paragraphs
    const full = layoutText(text, CR, SIZE, width, BIG, LEADING);

    const part1 = layoutText(text, CR, SIZE, width, LEADING * 2, LEADING);
    expect(part1.remainder).not.toBe('');
    const part2 = layoutText(part1.remainder, CR, SIZE, width, BIG, LEADING);
    expect(part2.remainder).toBe('');

    expect([...texts(part1), ...texts(part2)]).toEqual(texts(full));
  });
});
