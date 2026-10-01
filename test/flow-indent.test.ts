import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { paragraph, heading } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';

function fragX(indent?: { left?: number; right?: number; firstLine?: number }, text = 'Indented words here.'): number {
  const doc = Document.New();
  const flow = doc.NewFlow();
  flow.AddParagraph(text, indent ? { indent } : {});
  flow.Render();
  return doc.Pages[0].GetTextFragments()[0].quad[0];
}

describe('paragraph indent: left and right', () => {
  it('shifts the text right by the left indent', () => {
    expect(fragX({ left: 36 }) - fragX()).toBeCloseTo(36, 3);
  });

  it('narrows the box by the right indent, so a long paragraph wraps sooner', () => {
    const lines = (indent?: { right: number }): number => {
      const doc = Document.New();
      const flow = doc.NewFlow();
      flow.AddParagraph('word '.repeat(60), indent ? { indent } : {});
      flow.Render();
      return doc.Pages[0].GetText().trim().split('\n').length;
    };
    expect(lines({ right: 200 })).toBeGreaterThan(lines());
  });

  it('refuses a non-finite firstLineIndent on a text block', () => {
    const { page } = Document.New().AddPage();
    expect(() => page.AddTextBlock([{ text: 'x' }], [72, 72, 300, 300], { firstLineIndent: NaN })).toThrow(TypeError);
  });

  it('scales a hanging first line with a squeezed indent, so it stays in the column', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const els = paragraph('hang ' + 'body '.repeat(10), { indent: { left: 100000, firstLine: -100000 } });
    placeElements(doc, page, els, [72, 72, 451, 698]);
    const f = page.GetTextFragments();
    expect(f.length).toBeGreaterThan(0);
    // Unscaled, line 0 started 100000pt left of the column (x = -99489).
    for (const q of f.map((x) => x.quad)) {
      expect(q[0]).toBeGreaterThanOrEqual(72 - 0.01);
      expect(q[2]).toBeLessThanOrEqual(72 + 451 + 0.01);
    }
  });

  it('reports squeezed rather than throwing when the indent is wider than the column', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const els = paragraph('still drawn', { indent: { left: 10000 } });
    const seen: string[] = [];
    els[0].onCompromise = (how) => { seen.push(how); };
    expect(() => placeElements(doc, page, els, [72, 72, 451, 698])).not.toThrow();
    // Squeezed to the 12pt floor, each word lands on its own line.
    expect(page.GetText().replace(/\s+/g, ' ')).toContain('still drawn');
    expect(seen).toContain('squeezed');
  });

  it('refuses a negative left/right, a non-finite value, and a hanging indent past the left edge', () => {
    const flow = Document.New().NewFlow();
    expect(() => flow.AddParagraph('x', { indent: { left: -1 } })).toThrow(TypeError);
    expect(() => flow.AddParagraph('x', { indent: { right: Number.NaN } })).toThrow(TypeError);
    expect(() => flow.AddParagraph('x', { indent: { left: 10, firstLine: -11 } })).toThrow(TypeError);
  });

  it('indents a heading too', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddHeading(1, 'Title', { indent: { left: 50 } });
    flow.Render();
    const base = Document.New();
    const f2 = base.NewFlow(); f2.AddHeading(1, 'Title'); f2.Render();
    expect(doc.Pages[0].GetTextFragments()[0].quad[0] - base.Pages[0].GetTextFragments()[0].quad[0]).toBeCloseTo(50, 3);
  });

  it('keeps a heading keep-with-next eligible through the indent wrapper', () => {
    const [h] = heading(2, 'x', { indent: { left: 5 } });
    expect(h.keepWithNextEligible).toBe(true);
    const [p] = paragraph('x', { indent: { left: 5 } });
    expect(p.keepWithNextEligible).toBeFalsy();
  });
});

describe('paragraph indent: first line', () => {
  const lineStarts = (indent: { left?: number; firstLine?: number }) => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph('word '.repeat(40).trim(), { indent });
    flow.Render();
    const f = doc.Pages[0].GetTextFragments();
    const ys = [...new Set(f.map((x) => Math.round(x.quad[1])))].sort((a, b) => b - a);
    const firstX = (y: number) => Math.min(...f.filter((x) => Math.round(x.quad[1]) === y).map((x) => x.quad[0]));
    return { line0: firstX(ys[0]), line1: firstX(ys[1]) };
  };

  it('shifts the first line right and leaves the rest at the left indent', () => {
    const { line0, line1 } = lineStarts({ left: 20, firstLine: 36 });
    expect(line0 - line1).toBeCloseTo(36, 3);
  });

  it('hangs the first line left of the rest', () => {
    const { line0, line1 } = lineStarts({ left: 36, firstLine: -36 });
    expect(line1 - line0).toBeCloseTo(36, 3);
  });

  it('shifts the first line of a plain STRING paragraph too', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph('only words', { indent: { firstLine: 40 } });
    flow.Render();
    expect(doc.Pages[0].GetTextFragments()[0].quad[0]).toBeCloseTo(72 + 40, 3);
  });

  it('does not indent the first line of a CONTINUATION in the next column', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ columns: 2 });
    flow.AddParagraph('word '.repeat(2500).trim(), { indent: { firstLine: 40 } });
    flow.Render();
    const f = doc.Pages[0].GetTextFragments();
    const mid = doc.Pages[0].MediaBox[2] / 2;
    // The second column STARTS at the page middle, so `> mid` keeps only an
    // indented line and the comparison below measures nothing.
    const right = f.filter((x) => x.quad[0] > mid - 1);
    expect(right.length).toBeGreaterThan(10);
    const leftEdge = Math.min(...right.map((x) => x.quad[0]));
    const top = Math.max(...right.map((x) => x.quad[1]));
    const topLineX = Math.min(...right.filter((x) => Math.abs(x.quad[1] - top) < 1).map((x) => x.quad[0]));
    expect(topLineX).toBeCloseTo(leftEdge, 3);
  });

  it('keeps a link rect on its glyphs when the first line is indented', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'go', link: 'https://x.test/' }, { text: ' there' }], { indent: { firstLine: 50 } });
    flow.Render();
    const glyph = doc.Pages[0].GetTextFragments().find((x) => x.text.startsWith('go'))!;
    const link = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Link')!;
    expect(link.Rect![0]).toBeCloseTo(glyph.quad[0], 1);
  });

  it('centres a first-line-indented line within what the indent leaves', () => {
    const at = (firstLine: number) => {
      const doc = Document.New();
      const flow = doc.NewFlow();
      flow.AddParagraph('mid', { align: 'center', indent: { firstLine } });
      flow.Render();
      return doc.Pages[0].GetTextFragments()[0].quad[0];
    };
    expect(at(40) - at(0)).toBeCloseTo(20, 3);
  });
});
