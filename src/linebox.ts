/** Where a line's baseline sits and how tall its band is.
 *
 *  Invariant: it imports NOTHING and knows no font. Every rule here is
 *  testable from plain numbers with no PDF built — the split floatstack.ts,
 *  booklet.ts, tablespan.ts and docinfer.ts each already make, and for the
 *  same reason: this is geometry that is silently wrong when reversed.
 *
 *  Invariant: it never throws.
 *
 *  Invariant, and it is zch2.11's acceptance criterion: with no atomic items
 *  this COLLAPSES to the arithmetic layout.ts had before — ascent is the
 *  largest font size and height is `max(leading, ascent * leading /
 *  blockFontSize)`. test/rich-runs-identity.test.ts's four hashes depend on
 *  that being a collapse rather than a tolerance. */

/** One thing occupying a line: a text piece, or a box.
 *
 *  `ascent` is the ABOVE-BASELINE extent. For a text piece it is the font
 *  size — the conservative convention layout.ts already used, which includes
 *  descender room. For a baseline-aligned box it is the whole height, because
 *  its bottom edge sits on the baseline. For a top- or bottom-aligned box it
 *  is 0: those align to the BAND and do not move the baseline. */
export interface LineItem {
  ascent: number;
  height: number;
  align: 'baseline' | 'top' | 'bottom';
}

export function lineBox(
  items: LineItem[], leading: number, blockFontSize: number,
): { ascent: number; height: number } {
  let ascent = 0;
  let banded = 0;          // tallest item that aligns to the band, not the baseline
  for (const it of items) {
    if (it.align === 'baseline') ascent = Math.max(ascent, it.ascent);
    else banded = Math.max(banded, it.height);
  }
  // A line with no baseline-aligned item keeps ordinary leading rather than
  // collapsing: a blank line is still a line.
  if (ascent === 0) ascent = blockFontSize;
  // `blockFontSize` is validated positive by every entry point, so the ratio
  // is finite; a caller who asked for `leading: 0` still gets 0.
  const height = Math.max(leading, (ascent * leading) / blockFontSize, banded);
  return { ascent, height };
}
