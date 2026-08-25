import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { StructElement } from '../src/struct.js';

const SRC = [
  '| Name | Qty |',
  '| :--- | ---: |',
  '| apples | 12 |',
  '| pears | 7 |',
].join('\n');

const render = (src: string, flowOpts = {}, mdOpts = {}) => {
  const doc = Document.New();
  const flow = doc.NewFlow({ format: PageFormat.A4, ...flowOpts });
  const res = flow.AddMarkdown(src, { gfm: true, ...mdOpts });
  return { doc, pages: flow.Render(), res };
};

const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};

describe('Markdown tables', () => {
  it('renders a GFM table and reports nothing skipped', () => {
    const { pages, res } = render(SRC);
    expect(res.skipped).toEqual([]);
    const text = pages[0].GetText();
    expect(text).toContain('Name');
    expect(text).toContain('apples');
    expect(text).toContain('12');
  });

  it('renders inline styling and links inside cells', () => {
    const { pages } = render([
      '| a | b |',
      '| - | - |',
      '| **bold** | [docs](https://example.com) |',
    ].join('\n'));
    expect(pages[0].GetText()).toContain('bold');
    const links = pages[0].Annotations.filter((a) => a.Subtype === 'Link');
    expect(links.length).toBe(1);
    expect((links[0] as { Action?: { uri?: string } }).Action?.uri).toBe('https://example.com');
  });

  it('honours the column alignment', () => {
    const { pages } = render(SRC);
    const frags = pages[0].GetTextFragments();
    const qty = frags.find((f) => f.text.trim() === '12')!;
    const name = frags.find((f) => f.text.includes('apples'))!;
    // The right-aligned column's text ends further right than the left one's.
    expect(qty.quad[2]).toBeGreaterThan(name.quad[2]);
  });

  it('emits /Table /TR /TH /TD under a tagged flow', () => {
    const { doc } = render(SRC, { tagged: true });
    expect(collect(doc, 'Table').length).toBe(1);
    expect(collect(doc, 'TH').length).toBe(2);
    expect(collect(doc, 'TD').length).toBe(4);
  });

  it('repeats the header when a long table splits', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| r${i} | ${i} |`).join('\n');
    const { pages } = render(`| Name | Qty |\n| - | - |\n${rows}`);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      const t = p.GetText();
      if (/\br\d+\b/.test(t)) expect(t).toContain('Name');
    }
  });

  it('leaves a table unrendered when gfm is off', () => {
    // Without the extension the source is a paragraph, not a table.
    const { pages, res } = render(SRC, {}, { gfm: false });
    expect(res.skipped).toEqual([]);
    expect(pages[0].GetText()).toContain('Name');
  });

  it('reports no untagged content for a table and a link', () => {
    // UntaggedContent is a `warning`, so it lives in Issues, not Errors. It is
    // the rule the tagging half exists to keep quiet; the rest of PDF/UA (a
    // title, /Lang, …) is gl6o.4's business and is deliberately not asserted.
    const { doc } = render(`${SRC}\n\nSee [docs](https://example.com).`, { tagged: true });
    const untagged = doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'UntaggedContent');
    expect(untagged).toEqual([]);
  });

  it('renders through page.AddMarkdown too', () => {
    // The table element is an ordinary FlowElement, so the rect placer gets it
    // with no further work — the three-entry-point property gl6o.3.2 asserted,
    // now exercised on a source containing a table.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = page.AddMarkdown(SRC, [72, 72, 451, 698], { gfm: true });
    expect(res.skipped).toEqual([]);
    expect(res.remainder).toEqual([]);
    expect(page.GetText()).toContain('apples');
  });
});

describe('Markdown tables size to their content', () => {
  const WIDE = [
    '| Qty | Description |',
    '| --: | :---------- |',
    '| 12 | A reasonably long product description that needs room to breathe |',
  ].join('\n');

  it('stops the wide column wrapping that equal fractions forced', () => {
    const { pages } = render(WIDE);
    const frags = pages[0].GetTextFragments();
    // Measured before this change: the description wrapped onto a second line
    // at 'needs room to breathe'. Auto-fit gives it the width to stay on one.
    const desc = frags.filter((f) => f.text.includes('reasonably'));
    expect(desc.length).toBe(1);
    expect(desc[0].text).toContain('breathe');
  });

  it('gives the narrow column much less than half the table', () => {
    const { pages } = render(WIDE);
    const frags = pages[0].GetTextFragments();
    const qty = frags.find((f) => f.text.trim() === 'Qty')!;
    const desc = frags.find((f) => f.text.includes('Description'))!;
    // The Description column starts where the Qty column ends, so an early
    // start means Qty is narrow. Equal fractions put this near x=302.
    expect(desc.quad[0]).toBeLessThan(150);
    expect(qty.quad[0]).toBeLessThan(desc.quad[0]);
  });
});
