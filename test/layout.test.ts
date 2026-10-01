import { describe, it, expect } from 'vitest';
import { layoutText, layoutRuns, winAnsiDriver } from '../src/layout.js';

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

describe('layoutText remainder is the raw tail (pl2h)', () => {
  // It is cut from the input rather than rebuilt line by line, which is what
  // this function's own contract says it returns — "preserving spacing and
  // newlines". The rebuild did neither.
  it('keeps a blank paragraph that the rebuilt remainder dropped', () => {
    // An empty paragraph has no unit to hang a separator on, so the rebuild
    // emitted nothing at all for it AND suppressed the separator after it:
    // 'aaa\n\n\nbbb' came back as 'bbb', silently merging three paragraphs
    // into one. Re-placed by the flow engine, the blank lines vanished.
    const r = layoutText('aaa\n\n\nbbb', CR, SIZE, 60, LEADING, LEADING);
    expect(texts(r)).toEqual(['aaa']);
    expect(r.remainder).toBe('\n\nbbb');
  });

  it('keeps a run of spaces rather than collapsing it', () => {
    const r = layoutText('aaa  bbb  ccc', CR, SIZE, 30, LEADING, LEADING);
    expect(texts(r)).toEqual(['aaa']);
    expect(r.remainder).toBe('bbb  ccc');
  });

  it('starts at the first unplaced WORD, so the separator before it is gone', () => {
    // The space between the last placed line and the remainder is consumed by
    // the break, exactly as the rebuild consumed it — a remainder that opened
    // with a space would indent the continuation.
    const r = layoutText('aaa   bbb', CR, SIZE, 30, LEADING, LEADING);
    expect(r.remainder).toBe('bbb');
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

describe('first-line indent (m2fp.5)', () => {
  const run = (text: string) => [{ text, driver: CR, fontSize: SIZE }];
  const WORDS = 'aaaa bbbb cccc dddd eeee ffff gggg';   // each word 28.8pt, a space 7.2pt

  it('packs line 0 against boxWidth - indent and marks it; later lines use the full box', () => {
    const plain = layoutRuns(run(WORDS), 120, BIG, LEADING, SIZE);
    const ind = layoutRuns(run(WORDS), 120, BIG, LEADING, SIZE, 30);
    expect(plain.lines[0].text).toBe('aaaa bbbb cccc');
    expect(ind.lines[0].text).toBe('aaaa bbbb');
    expect(ind.lines[0].indent).toBe(30);
    expect(ind.lines[1].indent).toBeUndefined();
    expect(ind.lines[1].text).toBe('cccc dddd eeee');
  });

  it('lets a hanging (negative) first line pack WIDER than the box', () => {
    const hang = layoutRuns(run(WORDS), 120, BIG, LEADING, SIZE, -30);
    expect(hang.lines[0].indent).toBe(-30);
    expect(hang.lines[0].text).toBe('aaaa bbbb cccc dddd');
    expect(hang.lines[0].width).toBeGreaterThan(120);
  });

  it('never narrows line 0 below 12pt, however large the indent', () => {
    const got = layoutRuns(run(WORDS), 120, BIG, LEADING, SIZE, 500);
    expect(got.lines[0].indent).toBeCloseTo(108, 6);
  });

  it('is byte-identical with no indent: no line carries the key', () => {
    const got = layoutRuns(run(WORDS), 60, BIG, LEADING, SIZE);
    expect(got.lines.every((l) => !('indent' in l))).toBe(true);
  });
});
