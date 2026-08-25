import { describe, it, expect } from 'vitest';
import { renderHtml } from './helpers/md-html.js';
import type { MdBlock, MdDocument, MdItem } from '../src/mdast.js';

const doc = (...children: MdBlock[]): MdDocument => ({ type: 'document', children });

describe('md-html oracle', () => {
  it('renders a paragraph', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] })))
      .toBe('<p>hi</p>\n');
  });

  it('escapes text but not the tags around it', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [{ type: 'text', value: 'a<b & "c"' }] })))
      .toBe('<p>a&lt;b &amp; &quot;c&quot;</p>\n');
  });

  it('renders headings, thematic breaks and raw HTML blocks', () => {
    expect(renderHtml(doc({ type: 'heading', level: 3, children: [{ type: 'text', value: 'x' }] })))
      .toBe('<h3>x</h3>\n');
    expect(renderHtml(doc({ type: 'thematic_break' }))).toBe('<hr />\n');
    expect(renderHtml(doc({ type: 'html_block', literal: '<div>\n' }))).toBe('<div>\n');
  });

  it('renders a fenced code block with its info language', () => {
    expect(renderHtml(doc({ type: 'code_block', fenced: true, info: 'ts run', literal: 'a & b\n' })))
      .toBe('<pre><code class="language-ts">a &amp; b\n</code></pre>\n');
    expect(renderHtml(doc({ type: 'code_block', fenced: false, info: '', literal: 'x\n' })))
      .toBe('<pre><code>x\n</code></pre>\n');
  });

  it('renders a tight list with bare item content and a loose one with paragraphs', () => {
    const item: MdItem = { type: 'item', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a' }] }] };
    expect(renderHtml(doc({ type: 'list', ordered: false, start: 1, delimiter: '-', tight: true, children: [item] })))
      .toBe('<ul>\n<li>a</li>\n</ul>\n');
    expect(renderHtml(doc({ type: 'list', ordered: false, start: 1, delimiter: '-', tight: false, children: [item] })))
      .toBe('<ul>\n<li>\n<p>a</p>\n</li>\n</ul>\n');
  });

  it('emits start only when an ordered list does not start at 1', () => {
    const item: MdItem = { type: 'item', children: [] };
    expect(renderHtml(doc({ type: 'list', ordered: true, start: 1, delimiter: '.', tight: true, children: [item] })))
      .toBe('<ol>\n<li></li>\n</ol>\n');
    expect(renderHtml(doc({ type: 'list', ordered: true, start: 7, delimiter: '.', tight: true, children: [item] })))
      .toBe('<ol start="7">\n<li></li>\n</ol>\n');
  });

  it('renders inline emphasis, code, breaks and raw HTML', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [
      { type: 'emph', children: [{ type: 'text', value: 'a' }] },
      { type: 'strong', children: [{ type: 'text', value: 'b' }] },
      { type: 'code', value: 'c<d' },
      { type: 'softbreak' },
      { type: 'linebreak' },
      { type: 'html_inline', literal: '<br>' },
    ] }))).toBe('<p><em>a</em><strong>b</strong><code>c&lt;d</code>\n<br />\n<br></p>\n');
  });

  it('percent-encodes a destination and escapes its markup', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [
      { type: 'link', destination: '/a b?x=1&y=2', title: 'T"t', children: [{ type: 'text', value: 'L' }] },
    ] }))).toBe('<p><a href="/a%20b?x=1&amp;y=2" title="T&quot;t">L</a></p>\n');
  });

  it('does not double-encode an existing percent escape', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [
      { type: 'link', destination: '/a%20b', title: '', children: [{ type: 'text', value: 'L' }] },
    ] }))).toBe('<p><a href="/a%20b">L</a></p>\n');
  });

  it('percent-encodes non-ASCII as UTF-8 bytes', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [
      { type: 'link', destination: '/bä', title: '', children: [{ type: 'text', value: 'L' }] },
    ] }))).toBe('<p><a href="/b%C3%A4">L</a></p>\n');
  });

  it('renders an image with alt text flattened from its children', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [
      { type: 'image', destination: '/i.png', title: '', children: [
        { type: 'text', value: 'a' },
        { type: 'emph', children: [{ type: 'text', value: 'b' }] },
        { type: 'code', value: 'c' },
      ] },
    ] }))).toBe('<p><img src="/i.png" alt="abc" /></p>\n');
  });
});
