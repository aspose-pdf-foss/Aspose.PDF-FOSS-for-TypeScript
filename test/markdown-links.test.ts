import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { Page } from '../src/page.js';

const render = (src: string, opts = {}) => {
  const doc = Document.New();
  const flow = doc.NewFlow({ format: PageFormat.A4 });
  const res = flow.AddMarkdown(src, opts);
  const pages = flow.Render();
  return { doc, pages, res };
};

const linksOf = (p: Page) =>
  p.Annotations.filter((a) => a.Subtype === 'Link') as unknown as
    { Rect: number[]; Action?: { type: string; uri?: string } }[];

describe('Markdown links', () => {
  it('places a /URI annotation for an inline link', () => {
    const { pages } = render('See [the docs](https://example.com/docs) today.');
    const links = linksOf(pages[0]);
    expect(links.length).toBe(1);
    expect(links[0].Action).toEqual({ type: 'uri', uri: 'https://example.com/docs' });
  });

  it('links a reference link the same way', () => {
    const { pages } = render('See [the docs][d].\n\n[d]: https://example.com/ref');
    expect(linksOf(pages[0])[0].Action?.uri).toBe('https://example.com/ref');
  });

  it('gives two links in one paragraph their own destinations', () => {
    const { pages } = render('[one](https://a.example) and [two](https://b.example)');
    expect(linksOf(pages[0]).map((l) => l.Action?.uri).sort())
      .toEqual(['https://a.example', 'https://b.example']);
  });

  it('keeps adjacent links apart', () => {
    // No separating text at all: the two runs must not merge into one.
    const { pages } = render('[one](https://a.example)[two](https://b.example)');
    expect(linksOf(pages[0]).map((l) => l.Action?.uri).sort())
      .toEqual(['https://a.example', 'https://b.example']);
  });

  it('links a GFM autolink', () => {
    const { pages } = render('visit www.example.com now', { gfm: true });
    expect(linksOf(pages[0]).length).toBe(1);
  });

  it('links inside a heading and inside a list item', () => {
    const { pages } = render('# See [docs](https://h.example)\n\n- and [more](https://l.example)');
    expect(linksOf(pages[0]).map((l) => l.Action?.uri).sort())
      .toEqual(['https://h.example', 'https://l.example']);
  });

  it('renders an empty destination as styled text and reports it', () => {
    const { pages, res } = render('an [empty]() link');
    expect(linksOf(pages[0]).length).toBe(0);
    expect(res.skipped).toEqual(['link']);
    expect(pages[0].GetText()).toContain('empty');
  });

  it('keeps the link when a paragraph paginates across columns', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2 });
    // Fill most of column 1 so the linked paragraph straddles the break.
    flow.AddMarkdown(`${'filler paragraph text. '.repeat(120)}\n\n`
      + `${'body '.repeat(200)}[the link](https://example.com) ${'tail '.repeat(200)}`);
    const pages = flow.Render();
    const all = pages.flatMap((p) => linksOf(p));
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.every((l) => l.Action?.uri === 'https://example.com')).toBe(true);
  });
});
