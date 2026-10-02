import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

/** Two lines at `deg`, the second placed one line DOWN in the text's own
 *  frame — so every angle should read "Hello world" then "Second line". */
function rotated(deg: number): Document {
  const doc = Document.New(PageFormat.custom(400, 400));
  const t = (deg * Math.PI) / 180;
  const page = doc.Pages[0]!;
  page.AddText('Hello world', 200, 200, { rotate: deg });
  page.AddText('Second line', 200 + 20 * Math.sin(t), 200 - 20 * Math.cos(t), { rotate: deg });
  return doc;
}

describe('text at a non-horizontal baseline (w7jf)', () => {
  for (const deg of [0, 90, 180, 270, 30, -45]) {
    it(`reads lines in their own frame at ${deg}°`, () => {
      const page = rotated(deg).Pages[0]!;
      expect(page.GetText()).toBe('Hello world\nSecond line');
      expect(page.Search('Hello world')).toHaveLength(1);
      expect(page.Search('Second line')).toHaveLength(1);
    });
  }

  it('lays upright text out before a rotated stamp on the same page', () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    doc.Pages[0]!.AddText('Body text here', 50, 300);
    doc.Pages[0]!.AddText('STAMP', 200, 100, { rotate: 45 });
    expect(doc.Pages[0]!.GetText()).toBe('Body text here\nSTAMP');
  });

  it('lays each angle out separately, even when their line keys would interleave', () => {
    // At 270 degrees a line's key is -x; the two rotated lines sit at x 200
    // and 180, and the upright line's key (-y = -190) falls BETWEEN them. Laid
    // out together the upright line would split the rotated pair.
    const doc = rotated(270);
    doc.Pages[0]!.AddText('Body text', 20, 190);
    expect(doc.Pages[0]!.GetText()).toBe('Body text\nHello world\nSecond line');
  });

  it('keeps a nearly horizontal run on the upright line it belongs to', () => {
    // 0.4 degrees (0.007 rad) is inside the tolerance but rounds to angle group 1,
    // so only the tolerance keeps it here: a skewed scan or a sloppy producer,
    // not a rotated stamp. It must join "Hello" rather than form its own group.
    const doc = Document.New(PageFormat.custom(400, 400));
    doc.Pages[0]!.AddText('Hello', 20, 200);
    doc.Pages[0]!.AddText('world', 60, 200, { rotate: 0.4 });
    expect(doc.Pages[0]!.GetText()).toBe('Hello world');
  });

  it('reads the text of a /Rotate 90 page, upright as viewed', () => {
    const doc = Document.New(PageFormat.custom(200, 400));
    doc.Pages[0]!.Rotate = 90;
    doc.Pages[0]!.AddText('Upright when viewed', 100, 20, { rotate: 90 });
    expect(doc.Pages[0]!.GetText()).toBe('Upright when viewed');
  });

  it('merges a rotated run into one fragment', () => {
    const frags = rotated(90).Pages[0]!.GetTextFragments();
    expect(frags.map((f) => f.text)).toEqual(['Hello world', 'Second line']);
  });
});
