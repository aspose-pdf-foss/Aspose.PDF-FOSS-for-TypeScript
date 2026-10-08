import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const T = 'Hyphenation keeps documentation of extraordinary responsibility readable in narrow columns of text';
const narrow = { format: PageFormat.custom(200, 400), marginLeft: 40, marginRight: 40, marginTop: 20, marginBottom: 20 };
// Document.New starts with an empty page the flow does not use, so skip empties.
const text = (doc: Document) => Document.Open(doc.Save()).Pages.map((p) => p.GetText()).filter((t) => t !== '').join('\n');
const hasHyphenEnd = (s: string) => s.split('\n').some((l) => /[a-z]\u00AD$/.test(l));

describe('Flow hyphenation (v9j3.2)', () => {
  it('hyphenates a paragraph that asks', () => {
    const d = Document.New(PageFormat.A4);
    d.NewFlow(narrow).AddParagraph(T, { fontSize: 12, hyphenate: { lang: 'en' } }).Render();
    expect(hasHyphenEnd(text(d))).toBe(true);
  });

  it('applies the flow default, and false turns it off for one element', () => {
    const a = Document.New(PageFormat.A4);
    a.NewFlow({ ...narrow, hyphenate: { lang: 'en' } }).AddParagraph(T, { fontSize: 12 }).Render();
    expect(hasHyphenEnd(text(a))).toBe(true);
    const b = Document.New(PageFormat.A4);
    b.NewFlow({ ...narrow, hyphenate: { lang: 'en' } }).AddParagraph(T, { fontSize: 12, hyphenate: false }).Render();
    expect(hasHyphenEnd(text(b))).toBe(false);
  });

  it('keeps an element off with false when the flow also states a lang', () => {
    // The lang fallback must not turn `false` into `{ lang }`.
    const d = Document.New(PageFormat.A4);
    d.NewFlow({ ...narrow, tagged: true, lang: 'en-US', hyphenate: {} })
      .AddParagraph(T, { fontSize: 12, hyphenate: false }).Render();
    expect(hasHyphenEnd(text(d))).toBe(false);
  });

  it("takes the flow's lang when the option states none", () => {
    const d = Document.New(PageFormat.A4);
    d.NewFlow({ ...narrow, tagged: true, lang: 'en-US', hyphenate: {} }).AddParagraph(T, { fontSize: 12 }).Render();
    expect(hasHyphenEnd(text(d))).toBe(true);
  });

  it('hyphenates list item bodies', () => {
    const d = Document.New(PageFormat.A4);
    d.NewFlow(narrow).AddList([T, T], { fontSize: 12, hyphenate: { lang: 'en' } }).Render();
    expect(hasHyphenEnd(text(d))).toBe(true);
  });

  it('continues a hyphenated word on the next page', () => {
    const d = Document.New(PageFormat.A4);
    d.NewFlow({ ...narrow, format: PageFormat.custom(200, 80) })
      .AddParagraph(`${T} ${T} ${T}`, { fontSize: 12, hyphenate: { lang: 'en' } }).Render();
    const all = text(d).replace(/\u00AD\n/g, '').replace(/\n/g, ' ');
    expect(all).toBe(`${T} ${T} ${T}`);
  });

  it('refuses a bad option when the element is added, before Render', () => {
    const d = Document.New(PageFormat.A4);
    const f = d.NewFlow(narrow);
    expect(() => f.AddParagraph(T, { hyphenate: { lang: 'ru' } })).toThrow(RangeError);
    expect(() => d.NewFlow({ ...narrow, hyphenate: { mode: 'x' as never, lang: 'en' } })).toThrow(RangeError);
  });

  it('leaves a flow without the option byte-identical', () => {
    const a = Document.New(PageFormat.A4), b = Document.New(PageFormat.A4);
    a.NewFlow(narrow).AddParagraph(T, { fontSize: 12 }).Render();
    b.NewFlow({ ...narrow, hyphenate: undefined }).AddParagraph(T, { fontSize: 12, hyphenate: undefined }).Render();
    expect(b.Pages.map((p) => p.Contents)).toEqual(a.Pages.map((p) => p.Contents));
  });
});
