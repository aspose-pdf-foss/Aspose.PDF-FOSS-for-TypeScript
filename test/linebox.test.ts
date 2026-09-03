import { describe, it, expect } from 'vitest';
import { lineBox, type LineItem } from '../src/linebox.js';

const text = (fontSize: number): LineItem =>
  ({ ascent: fontSize, height: fontSize, align: 'baseline' });
const img = (h: number, align: LineItem['align'] = 'baseline'): LineItem =>
  ({ ascent: align === 'baseline' ? h : 0, height: h, align });

describe('lineBox', () => {
  it('reduces to the pre-zch2.11 arithmetic for text alone', () => {
    // THE acceptance criterion. Before this module the rule was
    //   ascent = max fontSize among runs with text, else blockFontSize
    //   height = max(leading, ascent * leading / blockFontSize)
    // and rich-runs-identity's four hashes depend on it character for
    // character. This must be a COLLAPSE, not a tolerance.
    expect(lineBox([text(10), text(10)], 12, 10)).toEqual({ ascent: 10, height: 12 });
    expect(lineBox([text(24), text(10)], 12, 10))
      .toEqual({ ascent: 24, height: (24 * 12) / 10 });
  });

  it('falls back to the block size for a line with no items', () => {
    // A blank line keeps ordinary leading rather than collapsing to zero.
    expect(lineBox([], 12, 10)).toEqual({ ascent: 10, height: 12 });
  });

  it('lets a baseline-aligned image raise the ascent, moving the baseline', () => {
    // Its bottom sits ON the baseline, so its above-baseline extent is its
    // full height — which is why maxFontSize had to be FED, not replaced.
    expect(lineBox([text(10), img(30)], 12, 10))
      .toEqual({ ascent: 30, height: (30 * 12) / 10 });
  });

  it('lets a TOP-aligned image raise the band WITHOUT moving the baseline', () => {
    // top/bottom align to the BAND, not the baseline. This is the second term
    // the model needed and the reason `middle` was excluded rather than
    // guessed at.
    expect(lineBox([text(10), img(40, 'top')], 12, 10))
      .toEqual({ ascent: 10, height: 40 });
  });

  it('does the same for a BOTTOM-aligned image', () => {
    expect(lineBox([text(10), img(40, 'bottom')], 12, 10))
      .toEqual({ ascent: 10, height: 40 });
  });

  it('does not shrink the band below the leading', () => {
    expect(lineBox([text(10), img(4, 'top')], 12, 10).height).toBe(12);
  });

  it('takes the largest of all three terms', () => {
    // A tall baseline image AND a taller top image: the ascent comes from the
    // first, the band from the second.
    const r = lineBox([text(10), img(20), img(50, 'top')], 12, 10);
    expect(r.ascent).toBe(20);
    expect(r.height).toBe(50);
  });

  it('honours a caller who asked for leading 0', () => {
    // stamp.ts validates blockFontSize positive, so the ratio is finite; a
    // zero leading must still produce a zero band.
    expect(lineBox([text(10)], 0, 10)).toEqual({ ascent: 10, height: 0 });
  });
});
