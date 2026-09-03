import { describe, it, expect } from 'vitest';
import { layoutRuns, type LayoutRun, type FontDriver } from '../src/layout.js';

/** A driver where every character is exactly 1pt wide at size 1, so widths are
 *  arithmetic a reader can check by hand. */
const drv: FontDriver = {
  measure: (t, fs) => t.length * fs,
  encode: (t) => new TextEncoder().encode(t),
  probe: (t) => t.length,
};

const txt = (text: string, fontSize = 1): LayoutRun => ({ text, driver: drv, fontSize });
const box = (width: number, height = 1, align: 'baseline' | 'top' | 'bottom' = 'baseline'):
  LayoutRun => ({ atomic: { width, height, align } });

describe('atomics in layoutRuns', () => {
  it('places an atomic between two words and gives it its own segment', () => {
    const { lines } = layoutRuns([txt('ab '), box(5), txt(' cd')], 100, 100, 2, 1);
    expect(lines).toHaveLength(1);
    const seg = lines[0].segments.find((s) => s.atomic !== undefined);
    expect(seg).toBeDefined();
    expect(seg!.width).toBe(5);
    expect(seg!.text).toBe('');
    expect(seg!.bytes).toHaveLength(0);
  });

  it('counts the atomic in the line width', () => {
    // 'ab' = 2, space = 1, box = 5, space = 1, 'cd' = 2.
    const { lines } = layoutRuns([txt('ab '), box(5), txt(' cd')], 100, 100, 2, 1);
    expect(lines[0].width).toBe(11);
  });

  it('keeps the separator space that FOLLOWS an atomic', () => {
    // Found while implementing, and it read as a 1pt rounding error rather
    // than a bug. piecesOf attributes a separator to "the run that precedes
    // it" — an atomic when one does — and adjacent same-run pieces MERGE, so
    // the space joined the atomic's piece, whose text the segment mapper
    // discards. The space vanished from the width AND from the page.
    const { lines } = layoutRuns([txt('ab '), box(5), txt(' cd')], 100, 100, 2, 1);
    expect(lines[0].text).toBe('ab  cd');
    expect(lines[0].segments.filter((s) => s.atomic !== undefined)).toHaveLength(1);
  });

  it('never puts U+FFFC in a line\'s text or bytes', () => {
    // The placeholder is internal. A driver asked to encode it would draw a
    // glyph nobody asked for.
    const { lines } = layoutRuns([txt('ab '), box(5), txt(' cd')], 100, 100, 2, 1);
    expect(lines[0].text).not.toContain('￼');
    expect(new TextDecoder().decode(lines[0].bytes)).not.toContain('￼');
  });

  it('wraps a line when the atomic no longer fits', () => {
    // 'aaaa' = 4 then a 5-wide box: 4 + 1 + 5 = 10 > 8, so the box wraps.
    const { lines } = layoutRuns([txt('aaaa '), box(5)], 8, 100, 2, 1);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('aaaa');
    expect(lines[1].segments.some((s) => s.atomic !== undefined)).toBe(true);
  });

  it('keeps an atomic ADJACENT to text in the same unbreakable word', () => {
    // `a<img>b` has no space, so it is one word — the correct CSS answer, and
    // it falls out of U+FFFC being a non-space character rather than from a
    // rule anyone wrote.
    const { lines } = layoutRuns([txt('a'), box(2), txt('b')], 100, 100, 2, 1);
    expect(lines).toHaveLength(1);
  });

  it('lets a tall baseline atomic raise the line band', () => {
    // leading 2, block size 1: a 6-tall box gives 6 * 2 / 1 = 12.
    const { lines } = layoutRuns([txt('a '), box(1, 6)], 100, 100, 2, 1);
    expect(lines[0].height).toBe(12);
    expect(lines[0].maxFontSize).toBe(6);
  });

  it('lets a TOP-aligned atomic raise the band without moving the baseline', () => {
    const { lines } = layoutRuns([txt('a '), box(1, 6, 'top')], 100, 100, 2, 1);
    expect(lines[0].height).toBe(6);
    expect(lines[0].maxFontSize).toBe(1);
  });

  it('carries an atomic into the REMAINDER when its line does not fit', () => {
    // boxHeight 2 fits exactly one line of leading 2.
    const { lines, remainder } = layoutRuns(
      [txt('aaaa '), box(5)], 8, 2, 2, 1);
    expect(lines).toHaveLength(1);
    expect(remainder.some((s) => s.text === '￼')).toBe(true);
  });

  it('lays out atomic-free input exactly as before', () => {
    // The collapse, asserted at this level too: same widths, same segment
    // count, one segment for a single-run line.
    const { lines } = layoutRuns([txt('hello world')], 100, 100, 2, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0].segments).toHaveLength(1);
    expect(lines[0].width).toBe(11);
    expect(lines[0].maxFontSize).toBe(1);
    expect(lines[0].height).toBe(2);
  });
});

describe('an over-wide atomic', () => {
  it('clamps to the box width, preserving the aspect', () => {
    // The rule flow.ts's image() already applies to a block image ("clamped
    // down to the region width if larger"), so it is one rule and not two.
    // 20 wide x 10 tall in a box of 8 becomes 8 x 4.
    const { lines } = layoutRuns([box(20, 10)], 8, 100, 2, 1);
    const seg = lines[0].segments.find((s) => s.atomic !== undefined)!;
    expect(seg.width).toBe(8);
    expect(seg.atomic!.height).toBe(4);
  });

  it('feeds the CLAMPED height to the band, not the original', () => {
    // Miss this and a wide photo reserves a band for a height it no longer
    // has, leaving a stripe of blank page under it.
    const { lines } = layoutRuns([box(20, 10)], 8, 100, 2, 1);
    expect(lines[0].height).toBe((4 * 2) / 1);
  });

  it('leaves an atomic that already fits untouched', () => {
    const { lines } = layoutRuns([box(4, 10)], 8, 100, 2, 1);
    const seg = lines[0].segments.find((s) => s.atomic !== undefined)!;
    expect(seg.width).toBe(4);
    expect(seg.atomic!.height).toBe(10);
  });

  it('ignores a zero-width atomic rather than dividing by it', () => {
    // A picture with no area is not damage; it contributes nothing and draws
    // nothing. The guard exists so the clamp's ratio is never 0/0.
    expect(() => layoutRuns([txt('a'), box(0, 0)], 8, 100, 2, 1)).not.toThrow();
  });

  it('does not mutate the caller\'s run objects', () => {
    // stamp.ts reuses the same objects for segmentBoxes and the painter, so a
    // clamp that wrote through would resize the image on every re-flow.
    const runs = [box(20, 10)];
    layoutRuns(runs, 8, 100, 2, 1);
    expect((runs[0] as { atomic: { width: number } }).atomic.width).toBe(20);
  });
});
