import { describe, it, expect } from 'vitest';
import {
  measureToPt, anchorShift, rectFromBox, XFA_ANCHORS,
  mediumSizePt, mediumAgrees, accumulateOrigin, chainIsPositioned, boxFor,
  MEDIUM_TOLERANCE_PT, buttonBox,
} from '../src/xfageom.js';

describe('measureToPt', () => {
  it('converts the four unambiguous units', () => {
    expect(measureToPt('1in')).toBeCloseTo(72, 9);
    expect(measureToPt('12pt')).toBeCloseTo(12, 9);
    expect(measureToPt('2.54cm')).toBeCloseTo(72, 9);
    expect(measureToPt('25.4mm')).toBeCloseTo(72, 9);
  });

  it('accepts a sign, a leading dot and whitespace around the unit', () => {
    expect(measureToPt('-0.5in')).toBeCloseTo(-36, 9);
    expect(measureToPt('  .5 in ')).toBeCloseTo(36, 9);
    expect(measureToPt('+1in')).toBeCloseTo(72, 9);
  });

  it('reads a bare number as points, which is the XFA default', () => {
    expect(measureToPt('18')).toBeCloseTo(18, 9);
  });

  // px/pc/em are refused, never guessed. A wrong px reading moves an A4 edge by
  // tens of points and still renders a plausible page, so the honest answer is
  // to decline the field entirely.
  it('refuses px, pc and em rather than guessing a conversion', () => {
    expect(measureToPt('10px')).toBeUndefined();
    expect(measureToPt('1pc')).toBeUndefined();
    expect(measureToPt('2em')).toBeUndefined();
  });

  it('refuses junk, an empty string and undefined', () => {
    expect(measureToPt('wide')).toBeUndefined();
    expect(measureToPt('1furlong')).toBeUndefined();
    expect(measureToPt('')).toBeUndefined();
    expect(measureToPt(undefined)).toBeUndefined();
    expect(measureToPt('Infinity')).toBeUndefined();
  });
});

describe('anchorShift', () => {
  it('defaults to topLeft, which shifts nothing', () => {
    expect(anchorShift(undefined, 100, 40)).toEqual({ dx: 0, dy: 0 });
    expect(anchorShift('topLeft', 100, 40)).toEqual({ dx: 0, dy: 0 });
  });

  // x/y NAME the anchor point, so the top-left corner is found by moving BACK
  // from it -- both deltas negative, never positive.
  it('moves back by half for a centre and by all for a far edge', () => {
    expect(anchorShift('middleCenter', 100, 40)).toEqual({ dx: -50, dy: -20 });
    expect(anchorShift('bottomRight', 100, 40)).toEqual({ dx: -100, dy: -40 });
    expect(anchorShift('topRight', 100, 40)).toEqual({ dx: -100, dy: 0 });
    expect(anchorShift('bottomLeft', 100, 40)).toEqual({ dx: 0, dy: -40 });
    expect(anchorShift('middleLeft', 100, 40)).toEqual({ dx: 0, dy: -20 });
    expect(anchorShift('topCenter', 100, 40)).toEqual({ dx: -50, dy: 0 });
  });

  it('covers all nine anchors and refuses anything else', () => {
    expect(XFA_ANCHORS).toHaveLength(9);
    for (const a of XFA_ANCHORS) expect(anchorShift(a, 10, 10)).toBeDefined();
    expect(anchorShift('centre', 10, 10)).toBeUndefined();
  });
});

describe('rectFromBox', () => {
  // The y-flip. A CropBox with a non-zero origin and a box near the TOP of the
  // page: the rect's ury must be just below cropTop, never just above
  // cropBottom -- the two readings agree only for a box at the page centre.
  it('flips y against the CropBox top and offsets by its origin', () => {
    const crop = [10, 20, 622, 812]; // 612 x 792, origin (10, 20)
    expect(rectFromBox({ x: 72, y: 36, w: 144, h: 18 }, crop))
      .toEqual([82, 758, 226, 776]);
  });

  it('places a box at the page top near ury, not near lly', () => {
    const crop = [0, 0, 612, 792];
    const [, lly, , ury] = rectFromBox({ x: 0, y: 0, w: 10, h: 10 }, crop);
    expect(ury).toBe(792);
    expect(lly).toBe(782);
  });
});

describe('mediumSizePt / mediumAgrees', () => {
  const usLetter = [0, 0, 612, 792];

  it('reads a portrait medium as short x long', () => {
    expect(mediumSizePt({ short: '8.5in', long: '11in' }))
      .toEqual({ w: 612, h: 792 });
  });

  // The swap is the whole reason orientation is read at all, and a square
  // medium could not tell the two readings apart.
  it('swaps short and long for landscape', () => {
    expect(mediumSizePt({ short: '8.5in', long: '11in', orientation: 'landscape' }))
      .toEqual({ w: 792, h: 612 });
  });

  it('agrees with a page it matches and refuses one it does not', () => {
    expect(mediumAgrees({ short: '8.5in', long: '11in' }, usLetter)).toBe(true);
    // A4 declared against a US Letter page: 17pt out on width.
    expect(mediumAgrees({ short: '210mm', long: '297mm' }, usLetter)).toBe(false);
  });

  it('absorbs a producer rounding but not a unit error', () => {
    expect(MEDIUM_TOLERANCE_PT).toBe(1);
    // 8.5in written to three decimals: 611.928pt, inside tolerance.
    expect(mediumAgrees({ short: '8.499in', long: '11in' }, usLetter)).toBe(true);
    // The same numbers with the orientation wrong: 180pt out.
    expect(mediumAgrees(
      { short: '8.5in', long: '11in', orientation: 'landscape' }, usLetter,
    )).toBe(false);
  });

  it('refuses an absent, unreadable or unit-less-than-certain medium', () => {
    expect(mediumSizePt(undefined)).toBeUndefined();
    expect(mediumSizePt({ short: '8.5in' })).toBeUndefined();
    expect(mediumSizePt({ short: '100px', long: '200px' })).toBeUndefined();
    expect(mediumAgrees(undefined, usLetter)).toBe(false);
  });
});

describe('chainIsPositioned', () => {
  it('accepts a chain of positions, including an empty one', () => {
    expect(chainIsPositioned([])).toBe(true);
    expect(chainIsPositioned(['position', 'position'])).toBe(true);
  });

  // The rule is on the WHOLE chain. A positioned subform inside a flowed one
  // has no fixed origin of its own -- precisely the case where a plausible
  // wrong answer is available.
  it('refuses a flow anywhere above, not only immediately above', () => {
    expect(chainIsPositioned(['tb', 'position'])).toBe(false);
    expect(chainIsPositioned(['position', 'lr-tb', 'position'])).toBe(false);
    expect(chainIsPositioned(['position', 'row'])).toBe(false);
    expect(chainIsPositioned(['position', 'table'])).toBe(false);
  });

  // Interpretation 3: a repeating subform's direction is unknowable, so the
  // template walker marks it and it degrades like any flow.
  it('refuses the synthetic occur marker and any layout it does not know', () => {
    expect(chainIsPositioned(['occur'])).toBe(false);
    expect(chainIsPositioned(['someFutureLayout'])).toBe(false);
  });
});

describe('accumulateOrigin', () => {
  // Three deep with a non-zero offset at EACH level -- the mutation "accumulate
  // from the immediate parent only" is invisible with fewer.
  it('sums every level of the chain, not just the last', () => {
    expect(accumulateOrigin([
      { x: '0.25in', y: '0.5in' },
      { x: '1in', y: '2in' },
      { x: '10pt', y: '20pt' },
    ])).toEqual({ x: 100, y: 200 });
  });

  it('treats an absent x or y as zero', () => {
    expect(accumulateOrigin([{ y: '1in' }, {}])).toEqual({ x: 0, y: 72 });
  });

  it('refuses the whole chain when any level is unreadable', () => {
    expect(accumulateOrigin([{ x: '1in' }, { x: '3px' }])).toBeUndefined();
  });
});

describe('boxFor', () => {
  it('adds the accumulated origin to the field own position', () => {
    expect(boxFor(
      { x: '1in', y: '2in', w: '3in', h: '0.25in' },
      [{ x: '0.5in', y: '0.5in' }],
    )).toEqual({ x: 108, y: 180, w: 216, h: 18 });
  });

  it('applies the anchor shift to the accumulated point', () => {
    expect(boxFor(
      { x: '1in', y: '1in', w: '2in', h: '1in', anchorType: 'middleCenter' },
      [],
    )).toEqual({ x: 0, y: 36, w: 144, h: 72 });
  });

  it('refuses a rotate, an unreadable measure and a bad anchor, each by name', () => {
    for (const own of [
      { x: '0', y: '0', w: '1in', h: '1in', rotate: '90' },
      { x: '0', y: '0', w: '1px', h: '1in' },
      { x: '0', y: '0', w: '1in', h: '1in', anchorType: 'centre' },
      { y: '0', w: '1in', h: '1in' },
    ]) {
      const r = boxFor(own, []);
      expect(r).toHaveProperty('reason');
      expect((r as { reason: string }).reason).toBeTruthy();
    }
  });

  it('accepts rotate="0", which is not a rotation', () => {
    expect(boxFor({ x: '0', y: '0', w: '1in', h: '1in', rotate: '0' }, []))
      .toEqual({ x: 0, y: 0, w: 72, h: 72 });
  });
});

describe('boxFor: the caption reserve', () => {
  // The rule the f1040 oracle found, in miniature. A field's box includes its
  // LABEL; the widget covers only the edit region. f1_01 is the real case:
  // 280.8pt wide with a 192.8pt reserve, and Adobe's widget is exactly 88pt.
  it('eats the reserve from the left by default', () => {
    expect(boxFor(
      { x: '0', y: '0', w: '280.8pt', h: '12pt' }, [], { reserve: '192.8pt' },
    )).toEqual({ x: 192.8, y: 0, w: 88, h: 12 });
  });

  it('eats it from whichever edge placement names', () => {
    const box = { x: '0', y: '0', w: '100pt', h: '50pt' };
    expect(boxFor(box, [], { reserve: '20pt', placement: 'right' }))
      .toEqual({ x: 0, y: 0, w: 80, h: 50 });
    // XFA's y runs DOWNWARD, so a top caption pushes the edit region down.
    expect(boxFor(box, [], { reserve: '20pt', placement: 'top' }))
      .toEqual({ x: 0, y: 20, w: 100, h: 30 });
    expect(boxFor(box, [], { reserve: '20pt', placement: 'bottom' }))
      .toEqual({ x: 0, y: 0, w: 100, h: 30 });
  });

  // presence="hidden" means the caption occupies NO space; "invisible" is
  // undrawn but still reserved, so it still eats.
  it('reserves nothing for a hidden caption and still reserves for an invisible one', () => {
    const box = { x: '0', y: '0', w: '100pt', h: '50pt' };
    expect(boxFor(box, [], { reserve: '20pt', presence: 'hidden' }))
      .toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(boxFor(box, [], { reserve: '20pt', presence: 'invisible' }))
      .toEqual({ x: 20, y: 0, w: 80, h: 50 });
  });

  it('leaves a captionless field alone', () => {
    expect(boxFor({ x: '0', y: '0', w: '100pt', h: '50pt' }, [], {}))
      .toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  // Never an approximate rect: a reserve that swallows the field, an unreadable
  // one, and a placement outside the four each degrade rather than guess.
  it('degrades rather than emitting a rect it cannot justify', () => {
    const box = { x: '0', y: '0', w: '100pt', h: '50pt' };
    for (const cap of [
      { reserve: '100pt' },
      { reserve: '120pt' },
      { reserve: '3px' },
      { reserve: '20pt', placement: 'inline' },
    ]) expect(boxFor(box, [], cap)).toHaveProperty('reason');
  });
});

describe('boxFor: the margin insets', () => {
  // The second rule the f1040 oracle found, and it corrects the guess this bug
  // was filed on: the residue is the <margin>, not the <border>. Measured over
  // all 54 distinct textEdit declaration shapes in that form, our width error
  // was leftInset+rightInset and our height error topInset+bottomInset, EXACTLY
  // and with no exception -- while the border edge thickness varied
  // independently across those same rows and moved nothing.
  it('insets the edit region by all four', () => {
    expect(boxFor(
      { x: '0', y: '0', w: '100pt', h: '50pt' }, [], undefined,
      { leftInset: '1pt', rightInset: '2pt', topInset: '4pt', bottomInset: '8pt' },
    )).toEqual({ x: 1, y: 4, w: 97, h: 38 });
  });

  it('treats an absent inset as zero and an absent margin as none', () => {
    const box = { x: '0', y: '0', w: '100pt', h: '50pt' };
    expect(boxFor(box, [], undefined, { rightInset: '10pt' }))
      .toEqual({ x: 0, y: 0, w: 90, h: 50 });
    expect(boxFor(box, [], undefined, {})).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(boxFor(box, [], undefined, undefined)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  // f1040's f1_03, whole: a 36x12 field with a 15pt left caption reserve and
  // rightInset="1.4111mm" topInset=bottomInset="0.1764mm". Adobe's widget is
  // [468.6 732.502 485.6 743.501] -- 17 x 10.999 -- against a field x of
  // 160.02mm. Both rules at once, on the numbers that found them.
  it('reproduces f1_03: the caption reserve and the insets together', () => {
    const b = boxFor(
      { x: '160.02mm', y: '16.933mm', w: '12.7mm', h: '4.233mm' }, [],
      { reserve: '5.2917mm' },
      { rightInset: '1.4111mm', topInset: '0.1764mm', bottomInset: '0.1764mm' },
    ) as { x: number; y: number; w: number; h: number };
    expect(b.x).toBeCloseTo(468.6, 2);
    expect(b.w).toBeCloseTo(17, 2);
    expect(b.h).toBeCloseTo(11, 2);
    // XFA's y runs DOWNWARD, so the top inset pushes the edit region down.
    expect(b.y).toBeCloseTo(48.5, 2);
  });

  it('degrades on an inset it cannot read, by name', () => {
    const r = boxFor(
      { x: '0', y: '0', w: '100pt', h: '50pt' }, [], undefined, { leftInset: '3px' },
    );
    expect(r).toHaveProperty('reason');
    expect((r as { reason: string }).reason).toContain('leftInset');
  });

  // Never an approximate rect: insets that leave no edit region degrade rather
  // than emitting a zero-or-negative one, exactly as the caption reserve does.
  it('degrades when the insets leave no edit region', () => {
    const box = { x: '0', y: '0', w: '100pt', h: '50pt' };
    expect(boxFor(box, [], undefined, { leftInset: '60pt', rightInset: '40pt' }))
      .toHaveProperty('reason');
    expect(boxFor(box, [], undefined, { topInset: '50pt' })).toHaveProperty('reason');
  });
});

describe('buttonBox: a checkButton is its own size, placed in the edit region', () => {
  // A checkButton states the button's OWN box, which is smaller than the
  // field's. Measured on BOTH vendored forms: `size="2.8222mm"` is 8pt and
  // every one of Adobe's 54 button rects across f1040 and fw9 is exactly 8x8.
  it('sizes the widget to the stated size, never the field box', () => {
    expect(buttonBox({ x: 0, y: 0, w: 20, h: 12 }, { size: '8pt' }))
      .toMatchObject({ w: 8, h: 8 });
  });

  // Vertical placement is the field's own <para vAlign>. Both non-default
  // values appear in the corpus -- f1040's c1_1 is `bottom`, the rest `middle`.
  it('places it vertically by vAlign, top by default', () => {
    const edit = { x: 0, y: 0, w: 20, h: 12 };
    expect(buttonBox(edit, { size: '8pt', vAlign: 'top' })).toMatchObject({ y: 0 });
    expect(buttonBox(edit, { size: '8pt', vAlign: 'middle' })).toMatchObject({ y: 2 });
    expect(buttonBox(edit, { size: '8pt', vAlign: 'bottom' })).toMatchObject({ y: 4 });
    expect(buttonBox(edit, { size: '8pt' })).toMatchObject({ y: 0 });
  });

  // The horizontal default is the surprising half, and it is MEASURED rather
  // than derived: no field in either form states hAlign, so every observed case
  // is the default -- and it is not one default but two. A caption on the RIGHT
  // puts the button flush LEFT; a caption on the left, or none at all, puts it
  // flush RIGHT. What settles it is fw9, where three buttons share x=14.4 and
  // all three of Adobe's rects start at exactly 73.0: only this pairing makes
  // a caption-right field and a caption-less one land on the same edge.
  it('places it horizontally opposite the caption by default', () => {
    const edit = { x: 0, y: 0, w: 20, h: 12 };
    expect(buttonBox(edit, { size: '8pt', captionPlacement: 'right' }))
      .toMatchObject({ x: 0 });
    expect(buttonBox(edit, { size: '8pt', captionPlacement: 'left' }))
      .toMatchObject({ x: 12 });
    expect(buttonBox(edit, { size: '8pt' })).toMatchObject({ x: 12 });
  });

  it('honours a stated hAlign over that default', () => {
    const edit = { x: 0, y: 0, w: 20, h: 12 };
    expect(buttonBox(edit, { size: '8pt', hAlign: 'left' })).toMatchObject({ x: 0 });
    expect(buttonBox(edit, { size: '8pt', hAlign: 'center' })).toMatchObject({ x: 6 });
    expect(buttonBox(edit, { size: '8pt', hAlign: 'right' })).toMatchObject({ x: 12 });
    // A stated hAlign wins even where the caption default would say otherwise.
    expect(buttonBox(edit, { size: '8pt', hAlign: 'right', captionPlacement: 'right' }))
      .toMatchObject({ x: 12 });
  });

  // No size stated is not the same as a size of zero: there is nothing to place,
  // so the edit region stands. Inventing a default is exactly the kind of number
  // this module refuses -- every field in both corpora states one.
  it('leaves the region alone when no size is stated', () => {
    const edit = { x: 1, y: 2, w: 20, h: 12 };
    expect(buttonBox(edit, {})).toEqual(edit);
  });

  it('degrades on a size it cannot read, by name', () => {
    const r = buttonBox({ x: 0, y: 0, w: 20, h: 12 }, { size: '3px' });
    expect(r).toHaveProperty('reason');
    expect((r as { reason: string }).reason).toContain('size');
  });

  // A button bigger than the room it is placed in never grows past that room --
  // it would overlap whatever sits beside it, and the field box is the one
  // bound the template actually states.
  it('clamps a size larger than the region', () => {
    expect(buttonBox({ x: 0, y: 0, w: 6, h: 4 }, { size: '8pt' }))
      .toEqual({ x: 0, y: 0, w: 6, h: 4 });
  });
});
