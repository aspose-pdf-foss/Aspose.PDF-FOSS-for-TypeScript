import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
function linked() {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12 });
  const doc = Document.Open(d.Save());
  const m = doc.Pages[0].Search('lazy dog')[0];
  doc.Pages[0].AddLink({ rect: m.quads[0], action: { type: 'uri', uri: 'https://example.com' } });
  doc.Pages[0].AddHighlight({ quads: m.quads.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]) });
  return doc;
}

describe('reflow moves glyph-anchored annotations (u3l5.5)', () => {
  it('re-derives a link and a highlight from the moved words', () => {
    const doc = linked();
    doc.Pages[0].ReplaceText('quick', 'remarkably quick indeed', { adjust: 'reflow' });
    const moved = doc.Pages[0].Search('lazy dog')[0].quads;
    for (const a of doc.Pages[0].Annotations) {
      const r = a.Rect!;
      const covers = moved.some((q) => q[0] >= r[0] - 0.01 && q[2] <= r[2] + 0.01 && q[1] >= r[1] - 0.01 && q[3] <= r[3] + 0.01);
      expect(covers).toBe(true);
    }
  });

  it('writes one quad per line the words now span', () => {
    const doc = linked();
    // Push "lazy" to the end of a line so "lazy dog" wraps. (Search cannot
    // match a phrase across a line break, so each word is found alone.)
    doc.Pages[0].ReplaceText('jumps', 'jumps and jumps and', { adjust: 'reflow' });
    const lazy = doc.Pages[0].Search('lazy')[0].quads[0], dog = doc.Pages[0].Search('dog')[0].quads[0];
    expect(dog[1]).toBeLessThan(lazy[1]);
    const hl = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
    const qp = hl.Dict.get('QuadPoints') as number[];
    expect(qp.length).toBe(16);
    // Top line first, each quad over its word: [x0 y1 x1 y1 x0 y0 x1 y0].
    for (const [i, q] of [lazy, dog].entries()) {
      expect(qp[8 * i]).toBeCloseTo(q[0], 3);
      expect(qp[8 * i + 2]).toBeCloseTo(q[2], 3);
      expect(qp[8 * i + 5]).toBeCloseTo(q[1], 3);
    }
  });

  it('leaves the annotations byte-identical when the paragraph is refused', () => {
    const doc = linked();
    doc.Pages[0].AddFreeText({ rect: [72, 680, 120, 700], contents: 'note' });
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('quick', 'remarkably quick indeed', { adjust: 'reflow' })).toThrow(/annotation/);
    expect(doc.Save()).toEqual(before);
  });
});
