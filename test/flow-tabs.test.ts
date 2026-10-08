// test/flow-tabs.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { paragraph } from '../src/flow.js';

const xOf = (d: Document, ch: string) => {
  for (const p of d.Pages) { const gs: GlyphEvent[] = []; visitContent(d, p, { glyph: (g) => gs.push(g) }); const g = gs.find((x) => x.text === ch); if (g) return g.quad[0]; }
  throw new Error(`no ${ch}`);
};
const geo = { format: PageFormat.A4, marginLeft: 72, marginRight: 72 };

describe('Flow tab stops (v9j3.1)', () => {
  it('a paragraph takes tabStops', () => {
    const d = Document.New(); d.NewFlow(geo).AddParagraph('ab\tZ', { font: 'Courier', fontSize: 10, tabStops: [{ position: 100 }] }).Render();
    expect(xOf(Document.Open(d.Save()), 'Z')).toBeCloseTo(172, 3);
  });
  it('a stop is measured from the COLUMN edge, not from past indent.left', () => {
    const d = Document.New(); d.NewFlow(geo).AddParagraph('ab\tZ', { font: 'Courier', fontSize: 10, indent: { left: 30 }, tabStops: [{ position: 100 }] }).Render();
    expect(xOf(Document.Open(d.Save()), 'Z')).toBeCloseTo(172, 3);
  });
  it('a flow-wide default applies, and false turns it off for one element', () => {
    const d = Document.New();
    d.NewFlow({ ...geo, tabStops: [{ position: 100 }] })
      .AddParagraph('ab\tZ', { font: 'Courier', fontSize: 10 })
      .AddParagraph('ab\tY', { font: 'Courier', fontSize: 10, tabStops: false }).Render();
    const doc = Document.Open(d.Save());
    expect(xOf(doc, 'Z')).toBeCloseTo(172, 3);
    expect(xOf(doc, 'Y')).toBeCloseTo(72 + 12, 3);                    // off: zero-width, as before
  });
  it('a heading and a list item take them; a list item is measured from the column edge', () => {
    const d = Document.New();
    d.NewFlow(geo).AddHeading(2, 'H\tZ', { font: 'Courier', fontSize: 10, tabStops: [{ position: 100 }] })
      .AddList([{ text: 'a\tY', tabStops: [{ position: 100 }] }], { font: 'Courier', fontSize: 10 }).Render();
    const doc = Document.Open(d.Save());
    expect(xOf(doc, 'Z')).toBeCloseTo(172, 3);
    expect(xOf(doc, 'Y')).toBeCloseTo(172, 3);
  });
  it('a continued paragraph lines up its columns on the next page', () => {
    const rows = Array.from({ length: 80 }, (_, i) => `r${i}\tv${i}`).join('\n');
    const d = Document.New(); d.NewFlow(geo).AddParagraph(rows, { font: 'Courier', fontSize: 10, tabStops: [{ position: 100 }] }).Render();
    const doc = Document.Open(d.Save());
    expect(doc.Pages.length).toBeGreaterThan(1);                      // the paragraph continued onto a second page
    const last = doc.Pages[doc.Pages.length - 1];
    const gs: GlyphEvent[] = []; visitContent(doc, last, { glyph: (g) => gs.push(g) });
    expect(gs.find((g) => g.text === 'v')!.quad[0]).toBeCloseTo(172, 3);
  });
  it('MEASURES from the column edge too, so a measured height agrees with the placed one', () => {
    // Box 170pt (200 less a 30pt indent); the stop at 100 is 70 into it. With
    // the origin honoured, 14 Courier X's (84pt) fit after it on one line; read
    // from the box edge instead, the stop sits 100 in and they wrap.
    const one = paragraph(`ab\t${'X'.repeat(14)}`, { font: 'Courier', fontSize: 10, indent: { left: 30 }, tabStops: [{ position: 100 }] });
    const plain = paragraph('ab', { font: 'Courier', fontSize: 10, indent: { left: 30 } });
    const m = one[0].measure!({ width: 200, availHeight: 1000 });
    expect(m.usedHeight).toBeCloseTo(plain[0].measure!({ width: 200, availHeight: 1000 }).usedHeight, 6);
  });
  it('validates when the element is added, before Render', () => {
    const f = Document.New().NewFlow(geo);
    expect(() => f.AddParagraph('a', { tabStops: [{ position: -5 }] })).toThrow(RangeError);
    expect(() => Document.New().NewFlow({ ...geo, tabStops: 'x' as never })).toThrow(TypeError);
  });
});
