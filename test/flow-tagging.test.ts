import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { StructElement } from '../src/struct.js';
import { paragraph } from '../src/flow.js';
import { quote } from '../src/flowblock.js';

/** Every element of `type` in the tree. The tree is cyclic (kids link back to
 *  parents), so it must be walked rather than serialized. */
const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};

const untagged = (doc: Document): number =>
  doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'UntaggedContent').length;

describe('a tagged code block', () => {
  it('leaves no untagged content', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddCodeBlock('const x = 1;\nconst y = 2;');
    flow.Render();
    expect(untagged(doc)).toBe(0);
  });

  it('emits /P > /Code', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddCodeBlock('const x = 1;');
    flow.Render();
    const codes = collect(doc, 'Code');
    expect(codes.length).toBe(1);
    // /Code is inline level (32000-1 14.8.4.3); its parent must be block level.
    expect(codes[0].Parent?.Type).toBe('P');
  });

  it('emits ONE /Code for a code block split across a column', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2, tagged: true });
    // Far more lines than one column can hold.
    flow.AddCodeBlock(Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    expect(collect(doc, 'Code').length).toBe(1);
  });

  it('creates no structure at all for an untagged flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddCodeBlock('const x = 1;');
    flow.Render();
    expect(doc.GetStructTree()).toBeNull();
  });
});

describe('a tagged block quote', () => {
  it('wraps its contents in one /BlockQuote', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddQuote([...paragraph('first'), ...paragraph('second'), ...paragraph('third')]);
    flow.Render();
    const bq = collect(doc, 'BlockQuote');
    // ONE element shared by all three children, not one each.
    expect(bq.length).toBe(1);
    expect(bq[0].Children.map((c) => c.Type)).toEqual(['P', 'P', 'P']);
  });

  it('puts a nested quote inside the outer one', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddQuote([...paragraph('outer'), ...quote(paragraph('inner'))]);
    flow.Render();
    const bq = collect(doc, 'BlockQuote');
    expect(bq.length).toBe(2);
    // The inner one is a descendant of the outer, not a sibling.
    expect(bq.some((e) => e.Parent?.Type === 'BlockQuote')).toBe(true);
  });

  it('emits ONE /BlockQuote for a quote split across a column', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2, tagged: true });
    const long = Array.from({ length: 40 },
      (_, i) => paragraph(`quoted paragraph number ${i} with enough words to occupy a line`));
    flow.AddQuote(long.flat());
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(collect(doc, 'BlockQuote').length).toBe(1);
  });

  it('leaves no untagged content', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddQuote(paragraph('quoted'));
    flow.Render();
    expect(untagged(doc)).toBe(0);
  });

  it('creates no structure at all for an untagged flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddQuote(paragraph('quoted'));
    flow.Render();
    expect(doc.GetStructTree()).toBeNull();
  });
});

/** Every Markdown construct, its expected structure types, in document order.
 *
 *  This table is the fence. It was written by MEASURING what each construct
 *  emits, which is how gl6o.4's defects were found at all: a code block emitted
 *  nothing and tripped UntaggedContent, and a quote emitted a bare /P.
 *
 *  The untagged count is asserted beside the types for every case, and that is
 *  load-bearing rather than belt-and-braces — measured by reverting the fix.
 *  Passing the /Code element to flowTextBlock is a SEPARATE step from creating
 *  it, so the reverted code still builds /P > /Code and the type list still
 *  matches exactly; the elements are simply empty and the glyphs belong to
 *  nothing. Only `untagged` goes red. A type list cannot tell a populated
 *  element from a hollow one, nor an element that was never created from one
 *  correctly artifacted. */
const CONSTRUCTS: [name: string, src: string, types: string[]][] = [
  ['heading', '# Title', ['Sect', 'H1']],
  ['paragraph', 'just a paragraph', ['Sect', 'P']],
  ['bullet list', '- a\n- b',
    ['Sect', 'L', 'LI', 'Lbl', 'LBody', 'LI', 'Lbl', 'LBody']],
  ['ordered list', '1. a\n2. b',
    ['Sect', 'L', 'LI', 'Lbl', 'LBody', 'LI', 'Lbl', 'LBody']],
  ['task list', '- [x] done\n- [ ] todo',
    ['Sect', 'L', 'LI', 'Lbl', 'LBody', 'LI', 'Lbl', 'LBody']],
  ['block quote', '> quoted text', ['Sect', 'BlockQuote', 'P']],
  ['code block', '```\ncode line\n```', ['Sect', 'P', 'Code']],
  // A thematic break is decoration and is correctly artifacted, so it
  // contributes no element — only the paragraphs either side of it.
  ['thematic break', 'before\n\n---\n\nafter', ['Sect', 'P', 'P']],
  ['table', '| a | b |\n| - | - |\n| 1 | 2 |',
    ['Sect', 'Table', 'TR', 'TH', 'TH', 'TR', 'TD', 'TD']],
  ['link', 'see [docs](https://example.com)', ['Sect', 'P', 'Link']],
];

describe('every Markdown construct tags itself', () => {
  for (const [name, src, expected] of CONSTRUCTS) {
    it(`${name}: emits ${expected.join(' > ')} and nothing untagged`, () => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
      flow.AddMarkdown(src, { gfm: true });
      flow.Render();

      const types: string[] = [];
      const walk = (e: StructElement): void => {
        types.push(e.Type);
        for (const k of e.Children) walk(k);
      };
      for (const k of doc.GetStructTree()!.Children) walk(k);

      expect(types).toEqual(expected);
      expect(untagged(doc)).toBe(0);
    });
  }
});

describe('FlowOptions.lang', () => {
  const naturalLanguageErrors = (doc: Document): number =>
    doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'NaturalLanguage').length;

  it('clears every NaturalLanguage error', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: 'en-US' });
    flow.AddMarkdown('# T\n\npara\n\n- a\n- b');
    flow.Render();
    expect(naturalLanguageErrors(doc)).toBe(0);
  });

  it('writes the flow /Sect, not the catalog', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: 'fr-FR' });
    flow.AddMarkdown('bonjour');
    flow.Render();
    expect(collect(doc, 'Sect')[0].Lang).toBe('fr-FR');
    // The document's own language is untouched: a flow appended to an existing
    // document must not relabel it.
    expect(doc.Lang).toBeUndefined();
  });

  it('lets two flows carry different languages in one document', () => {
    const doc = Document.New();
    // AddMarkdown returns a report rather than `this` — the one Flow.Add* that
    // is not chainable — so each flow needs its own statement.
    const en = doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: 'en-US' });
    en.AddMarkdown('english');
    en.Render();
    const fr = doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: 'fr-FR' });
    fr.AddMarkdown('francais');
    fr.Render();
    expect(collect(doc, 'Sect').map((s) => s.Lang).sort()).toEqual(['en-US', 'fr-FR']);
    expect(naturalLanguageErrors(doc)).toBe(0);
  });

  it('rejects lang without tagged', () => {
    const doc = Document.New();
    // An untagged flow has no /Sect to carry it, so the option would silently do
    // nothing — the exact failure this issue exists to close.
    expect(() => doc.NewFlow({ format: PageFormat.A4, lang: 'en-US' })).toThrow(TypeError);
  });

  it('rejects an empty lang', () => {
    const doc = Document.New();
    expect(() => doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: '' }))
      .toThrow(TypeError);
  });

  it('leaves a flow with no lang exactly as before', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddMarkdown('para');
    flow.Render();
    expect(collect(doc, 'Sect')[0].Lang).toBeUndefined();
  });
});
