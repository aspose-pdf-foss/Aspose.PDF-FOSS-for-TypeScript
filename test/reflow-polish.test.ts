import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

// Follow-ups to `adjust: 'reflow'` (u3l5.11). Boxes are [x, y, w, h].
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
const B2 = 'Second paragraph words here sit below the first one';
const xOf = (doc: Document, s: string): number => doc.Pages[0].Search(s)[0].quads[0][0];
const yOf = (doc: Document, s: string): number => doc.Pages[0].Search(s)[0].quads[0][1];
const build = (draw: (d: Document) => void): Document => {
  const d = Document.New(PageFormat.A4);
  draw(d);
  return Document.Open(d.Save());
};

describe('reflow: a centred or right-aligned paragraph keeps its short last line (u3l5.11)', () => {
  for (const align of ['center', 'right'] as const) {
    it(`grows a ${align}-aligned paragraph whose last line sits far in`, () => {
      // The last line, "woods", sits far in from the others, so the layout's
      // left-edge grouping makes it a block of its own.
      const doc = build((d) => d.Pages[0].AddTextBlock(T, [72, 300, 200, 400], { fontSize: 12, align }));
      // The edge of the LINE holding `s`, from the structured text.
      const edge = (s: string) => {
        const l = doc.Pages[0].GetStructuredText().flatMap((x) => x.lines).find((x) => x.text.includes(s))!;
        return align === 'center' ? (l.quad[0] + l.quad[2]) / 2 : l.quad[2];
      };
      const want = align === 'center' ? 172 : 272;
      expect(edge('woods')).toBeCloseTo(want, 0);
      doc.Pages[0].ReplaceText('quick', 'remarkably quick indeed', { adjust: 'reflow' });
      expect(doc.Pages[0].GetText()).toContain('remarkably quick indeed');
      expect(edge('woods')).toBeCloseTo(want, 0);
    });
  }

  it('does not join an indented line to a left-aligned paragraph above it at the same pitch', () => {
    // Directly under the last line, at the paragraph's own pitch but far in:
    // only the alignment test can keep it out — the left edges do not share a
    // centre or a right edge.
    const doc = build((d) => d.Pages[0].AddTextBlock(T, [72, 600, 200, 100], { fontSize: 12 }));
    const lines = doc.Pages[0].GetStructuredText().flatMap((b) => b.lines);
    const pitch = lines[0].quad[1] - lines[1].quad[1];
    doc.Pages[0].AddText('Caption', 150, lines[lines.length - 1].quad[1] - pitch, { fontSize: 12 });
    const at = doc.Pages[0].Search('Caption')[0].quads[0];
    doc.Pages[0].ReplaceText('quick brown', 'q', { adjust: 'reflow' });
    expect(doc.Pages[0].Search('Caption')[0].quads[0]).toEqual(at);
  });
});

describe('reflow: an annotation over two paragraphs (u3l5.11)', () => {
  it('moves the quad over the reflowed paragraph and keeps the other', () => {
    const doc = build((d) => {
      d.Pages[0].AddTextBlock(T, [72, 600, 200, 100], { fontSize: 12 });
      d.Pages[0].AddTextBlock(B2, [72, 400, 200, 100], { fontSize: 12 });
    });
    const lazy = doc.Pages[0].Search('lazy')[0].quads[0], words = doc.Pages[0].Search('words')[0].quads[0];
    const quad = ([x0, y0, x1, y1]: number[]) => [x0, y1, x1, y1, x0, y0, x1, y0];
    doc.Pages[0].AddHighlight({ quads: [...quad(lazy), ...quad(words)] });
    doc.Pages[0].ReplaceText('quick brown', 'q', { adjust: 'reflow' });
    const moved = doc.Pages[0].Search('lazy')[0].quads[0];
    expect(moved[0]).not.toBeCloseTo(lazy[0], 1);
    const qp = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!.Dict.get('QuadPoints') as number[];
    expect(qp.length).toBe(16);
    expect(qp[0]).toBeCloseTo(moved[0], 3);
    expect(qp.slice(8)).toEqual(quad(words));
  });
});

describe('reflow: room below counts annotations (u3l5.11)', () => {
  it('refuses to grow into an annotation below the paragraph, changing nothing', () => {
    const doc = build((d) => d.Pages[0].AddTextBlock(T, [72, 600, 200, 100], { fontSize: 12 }));
    const bottom = yOf(doc, 'woods');
    doc.Pages[0].AddLink({ rect: [72, bottom - 20, 272, bottom - 6], action: { type: 'uri', uri: 'https://example.com' } });
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('quick', 'remarkably quick indeed', { adjust: 'reflow' })).toThrow(/no-room/);
    expect(doc.Save()).toEqual(before);
  });

  it('still grows when the annotation sits clear of the new lines', () => {
    const doc = build((d) => d.Pages[0].AddTextBlock(T, [72, 600, 200, 100], { fontSize: 12 }));
    const bottom = yOf(doc, 'woods');
    doc.Pages[0].AddLink({ rect: [72, bottom - 200, 272, bottom - 180], action: { type: 'uri', uri: 'https://example.com' } });
    expect(() => doc.Pages[0].ReplaceText('quick', 'remarkably quick indeed', { adjust: 'reflow' })).not.toThrow();
  });
});

describe('reflow: a match crossing two paragraphs (u3l5.11)', () => {
  it('closes up the paragraph that only lost text', () => {
    const doc = build((d) => {
      d.Pages[0].AddTextBlock(T, [72, 600, 200, 100], { fontSize: 12 });
      d.Pages[0].AddTextBlock(B2, [72, 400, 200, 100], { fontSize: 12 });
    });
    expect(xOf(doc, 'paragraph')).toBeGreaterThan(100);
    expect(doc.Pages[0].ReplaceText(/woods\s+Second/, 'woods!', { adjust: 'reflow' })).toBe(1);
    expect(doc.Pages[0].GetText()).toContain('woods!');
    expect(xOf(doc, 'paragraph')).toBeCloseTo(72, 3);
  });
});
