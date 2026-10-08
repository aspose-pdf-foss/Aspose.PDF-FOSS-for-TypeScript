import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { createTable } from '../src/tableauthor.js';

const W = 'extraordinary responsibility documentation';
const text = (doc: Document) => Document.Open(doc.Save()).Pages.map((p) => p.GetText()).filter((t) => t !== '').join('\n');
const hyphenEnds = (s: string) => s.split('\n').filter((l) => /[a-z]\u00AD$/.test(l)).length;

describe('table cells hyphenate (v9j3.2)', () => {
  it('cascades from table defaults and sizes the row for the hyphenated text', () => {
    const t = createTable({ fontSize: 12, hyphenate: { lang: 'en' } });
    t.setColumnWidths([{ fixed: 70 }]);
    t.addRow([W]);
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTable(t, 72, 700, { width: 70 });
    expect(hyphenEnds(text(d))).toBeGreaterThan(0);
    for (const f of Document.Open(d.Save()).Pages[0].GetTextFragments()) expect(f.quad[2]).toBeLessThanOrEqual(72 + 70 + 0.01);
  });

  it('lets a cell turn it on for itself only', () => {
    const t = createTable({ fontSize: 12 });
    t.setColumnWidths([{ fixed: 70 }, { fixed: 70 }]);
    const r = t.addRow();
    r.addCell(W, { hyphenate: { lang: 'en' } });
    r.addCell(W);
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTable(t, 72, 700, { width: 140 });
    const right = Document.Open(d.Save()).Pages[0].GetTextFragments().filter((f) => f.quad[0] > 72 + 70);
    expect(right.some((f) => /[-\u00AD]$/.test(f.text))).toBe(false);
    expect(hyphenEnds(text(d))).toBeGreaterThan(0);
  });

  it('refuses a bad option when the table is built', () => {
    expect(() => createTable({ hyphenate: { lang: 'ru' } })).toThrow(RangeError);
  });
});

describe('Markdown hyphenates (v9j3.2)', () => {
  it('paragraphs, lists and tables', () => {
    const md = `${W} ${W}\n\n- ${W}\n\n| a |\n|---|\n| ${W} |\n`;
    // doc.AddMarkdown lays out on its own flow, sized by these options.
    const d = Document.New(PageFormat.A4);
    d.AddMarkdown(md, { hyphenate: { lang: 'en' }, gfm: true, format: PageFormat.custom(200, 800), marginLeft: 40, marginRight: 40 });
    expect(hyphenEnds(text(d))).toBeGreaterThanOrEqual(2);
  });

  it('takes the flow default through Flow.AddMarkdown', () => {
    const d = Document.New(PageFormat.A4);
    const f = d.NewFlow({ format: PageFormat.custom(200, 800), marginLeft: 40, marginRight: 40, hyphenate: { lang: 'en' } });
    f.AddMarkdown(`${W} ${W}`);
    f.Render();
    expect(hyphenEnds(text(d))).toBeGreaterThan(0);
  });

  it("takes the flow's lang when its own hyphenate states none, and false opts out", () => {
    const geo = { format: PageFormat.custom(200, 800), marginLeft: 40, marginRight: 40, tagged: true, lang: 'en-US' };
    const a = Document.New(PageFormat.A4);
    const fa = a.NewFlow(geo);
    fa.AddMarkdown(`${W} ${W}`, { hyphenate: {} });
    fa.Render();
    expect(hyphenEnds(text(a))).toBeGreaterThan(0);
    const b = Document.New(PageFormat.A4);
    const fb = b.NewFlow({ ...geo, hyphenate: {} });
    fb.AddMarkdown(`${W} ${W}`, { hyphenate: false });
    fb.Render();
    expect(hyphenEnds(text(b))).toBe(0);
  });

  it('refuses a bad option before building', () => {
    expect(() => Document.New(PageFormat.A4).AddMarkdown('x', { hyphenate: { lang: 'ru' } })).toThrow(RangeError);
  });
});
