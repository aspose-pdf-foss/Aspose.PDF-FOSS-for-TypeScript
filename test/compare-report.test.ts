import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { CompareTextOptions } from '../src/compare.js';
import { comparisonToHtml, comparisonToMarkdown, comparisonToJson } from '../src/comparereport.js';
import { parseMarkdown } from '../src/markdown.js';
import type { MdInline } from '../src/mdast.js';
import { buildMultiPageTextPdf } from './helpers/build-text-pdf.js';

const doc = (...pages: string[][]): Document => Document.Open(buildMultiPageTextPdf(
  pages.map((lines) => lines.map((l, i) => `BT /F1 10 Tf 20 ${260 - 20 * i} Td (${l}) Tj ET`).join('\n')),
));
const cmp = (a: string[][], b: string[][], o?: CompareTextOptions) => doc(...a).CompareText(doc(...b), o);
const QUICK = () => cmp([['the quick brown fox']], [['the slow brown fox']]);

/** Flatten a paragraph's inlines to `text`, `~~text~~`, `**text**`, `<tag>`. */
function inline(ns: MdInline[]): string {
  return ns.map((n) => {
    if (n.type === 'text') return n.value;
    if (n.type === 'strikethrough') return `~~${inline(n.children)}~~`;
    if (n.type === 'strong') return `**${inline(n.children)}**`;
    if (n.type === 'html_inline') return n.literal;
    return `?${n.type}`;
  }).join('');
}
const mdParagraphs = (md: string): string[] =>
  parseMarkdown(md, { gfm: true }).children.filter((b) => b.type === 'paragraph').map((b) => inline((b as { children: MdInline[] }).children));

describe('comparisonToHtml', () => {
  it('marks deletions and insertions in a fragment', () => {
    expect(comparisonToHtml(QUICK(), { fragment: true })).toBe(
      '<div class="pdf-diff">\n<p>the <del>quick</del> <ins>slow</ins> brown fox</p>\n</div>\n');
  });

  it('writes a complete document with a style sheet, a title and a summary', () => {
    const html = comparisonToHtml(QUICK(), { title: 'v1 <> v2' });
    expect(html.startsWith('<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>v1 &lt;&gt; v2</title>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('del {');
    expect(html).toContain('<p class="summary">1 deleted, 1 inserted, similarity 75%</p>');
    expect(html).toContain('<p>the <del>quick</del> <ins>slow</ins> brown fox</p>');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('escapes text', () => {
    const html = comparisonToHtml(cmp([['a<b & c']], [['a<b & d']]), { fragment: true });
    expect(html).toContain('<p>a&lt;b &amp; <del>c</del> <ins>d</ins></p>');
  });

  it('shows the second document\'s spelling of equal text', () => {
    const html = comparisonToHtml(cmp([['Hello World']], [['hello world']], { ignoreCase: true }), { fragment: true });
    expect(html).toContain('<p>hello world</p>');
    // and when a stretch is cut, the kept words are the second spelling too
    const cut = comparisonToHtml(cmp([['A B C D old']], [['a b c d new']], { ignoreCase: true }), { fragment: true, context: 1 });
    expect(cut).toContain('<p><span class="elided">…</span> d <del>old</del>');
  });

  it('gives each page pair its own section in pages mode', () => {
    const html = comparisonToHtml(cmp([['one'], ['gone']], [['one', 'two']], { mode: 'pages' }), { fragment: true });
    expect(html).toBe('<div class="pdf-diff">\n'
      + '<section>\n<h2>Page 1</h2>\n<p>one <ins>two</ins></p>\n</section>\n'
      + '<section>\n<h2>Page 2 (first document only)</h2>\n<p><del>gone</del></p>\n</section>\n'
      + '</div>\n');
    const back = comparisonToHtml(cmp([['one']], [['one'], ['new']], { mode: 'pages' }), { fragment: true });
    expect(back).toContain('<h2>Page 2 (second document only)</h2>');
  });

  it('cuts long unchanged stretches to context words either side of a change', () => {
    const words = 'w1 w2 w3 w4 w5 w6 w7 w8';
    const r = cmp([[`${words} old ${words}`]], [[`${words} new ${words}`]]);
    expect(comparisonToHtml(r, { fragment: true, context: 2 })).toContain(
      '<p><span class="elided">…</span> w7 w8 <del>old</del> <ins>new</ins> w1 w2 <span class="elided">…</span></p>');
    expect(comparisonToHtml(r, { fragment: true, context: 0 })).toContain(
      '<p><span class="elided">…</span> <del>old</del> <ins>new</ins> <span class="elided">…</span></p>');
    // a stretch no longer than what it would keep is kept whole
    expect(comparisonToHtml(r, { fragment: true, context: 8 })).toContain(`<p>${words} <del>old</del>`);
  });

  it('cuts an identical comparison to one ellipsis under a finite context: no change to keep it around', () => {
    const r = cmp([['a b c']], [['a b c']]);
    expect(comparisonToHtml(r, { fragment: true, context: 2 })).toContain('<p><span class="elided">…</span></p>');
    expect(comparisonToHtml(r, { fragment: true })).toContain('<p>a b c</p>');
  });

  it('keeps a stretch between two changes whole when it fits both contexts', () => {
    const r = cmp([['x a b c y']], [['X a b c Y']]);
    expect(comparisonToHtml(r, { fragment: true, context: 2 })).toContain(
      '<p><del>x</del> <ins>X</ins> a b c <del>y</del> <ins>Y</ins></p>');
  });

  it('marks changes inside words at character granularity, with a visible space', () => {
    expect(comparisonToHtml(cmp([['colour']], [['color']], { granularity: 'character' }), { fragment: true }))
      .toContain('<p>colo<del>u</del>r</p>');
    expect(comparisonToHtml(cmp([['data base']], [['database']], { granularity: 'character' }), { fragment: true }))
      .toContain('<p>data<del>␣</del>base</p>');
  });

  it('writes an identical comparison as plain text and an empty one as an empty paragraph', () => {
    expect(comparisonToHtml(cmp([['same']], [['same']]), { fragment: true })).toContain('<p>same</p>');
    expect(comparisonToHtml(cmp([['']], [['']]), { fragment: true })).toBe('<div class="pdf-diff">\n<p></p>\n</div>\n');
  });

  it.each([
    [{ context: -1 }, RangeError], [{ context: 1.5 }, RangeError], [{ title: 3 }, TypeError],
  ] as [object, ErrorConstructor][])('refuses %j', (o, E) => {
    expect(() => comparisonToHtml(QUICK(), o as never)).toThrow(E);
  });
});

describe('comparisonToMarkdown', () => {
  it('strikes deletions and bolds insertions, which our parser reads back', () => {
    const md = comparisonToMarkdown(QUICK());
    expect(md).toBe('the ~~quick~~ **slow** brown fox\n');
    expect(mdParagraphs(md)).toEqual(['the ~~quick~~ **slow** brown fox']);
  });

  it('escapes Markdown punctuation inside and outside the marks', () => {
    const md = comparisonToMarkdown(cmp([['a*b ~x~ [c]']], [['a*b ~x~ [d]']]));
    expect(mdParagraphs(md)).toEqual(['a*b ~x~ ~~[c]~~ **[d]**']);
    // punctuation INSIDE a mark is escaped too, or p*q*r would turn to emphasis
    expect(mdParagraphs(comparisonToMarkdown(cmp([['k p*q*r']], [['k s_t_u']])))).toEqual(['k ~~p*q*r~~ **s_t_u**']);
  });

  it('escapes a line-leading block opener', () => {
    const md = comparisonToMarkdown(cmp([['# not a heading']], [['# not a heading']]));
    expect(mdParagraphs(md)).toEqual(['# not a heading']);
  });

  it('uses del and ins tags at character granularity, where delimiters could not flank', () => {
    const md = comparisonToMarkdown(cmp([['(colour)']], [['(color)']], { granularity: 'character' }));
    expect(md).toBe('(colo<del>u</del>r)\n');
    expect(mdParagraphs(md)).toEqual(['(colo<del>u</del>r)']);
  });

  it('heads each page pair in pages mode', () => {
    const md = comparisonToMarkdown(cmp([['one'], ['gone']], [['one', 'two']], { mode: 'pages' }));
    expect(md).toBe('## Page 1\n\none **two**\n\n## Page 2 (first document only)\n\n~~gone~~\n');
  });

  it('cuts long unchanged stretches', () => {
    const words = 'w1 w2 w3 w4 w5';
    const md = comparisonToMarkdown(cmp([[`${words} old`]], [[`${words} new`]]), { context: 1 });
    expect(md).toBe('… w5 ~~old~~ **new**\n');
  });
});

describe('comparisonToJson', () => {
  it('writes the comparison with its spans', () => {
    const r = QUICK();
    const j = JSON.parse(comparisonToJson(r));
    expect(j).toEqual({ granularity: 'word', minimal: true, stats: r.stats, changes: r.changes });
    expect(j.pages).toBeUndefined();
  });

  it('drops the spans when asked', () => {
    const j = JSON.parse(comparisonToJson(QUICK(), { spans: false }));
    expect(j.changes[1]).toEqual({ op: 'delete', oldText: 'quick', newText: '' });
  });

  it('includes the page pairs in pages mode', () => {
    const r = cmp([['one'], ['gone']], [['one']], { mode: 'pages' });
    const j = JSON.parse(comparisonToJson(r, { spans: false }));
    expect(j.pages.map((p: { oldPage?: number; newPage?: number }) => [p.oldPage, p.newPage ?? null])).toEqual([[1, 1], [2, null]]);
    expect(j.pages[1].changes).toEqual([{ op: 'delete', oldText: 'gone', newText: '' }]);
  });

  it('indents by two spaces unless told otherwise', () => {
    expect(comparisonToJson(QUICK())).toContain('\n  "granularity"');
    expect(comparisonToJson(QUICK(), { indent: 0 })).not.toContain('\n');
  });

  it('refuses a bad indent', () => {
    expect(() => comparisonToJson(QUICK(), { indent: -2 })).toThrow(RangeError);
  });
});
