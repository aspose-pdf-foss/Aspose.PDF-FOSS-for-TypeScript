import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDocModel, type DocContainer, type DocNode } from '../src/docmodel.js';

/** A tagged document from Markdown, reopened from its own bytes. */
function tagged(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { tagged: true, gfm: true });
  return Document.Open(doc.Save());
}

/** Every Link container in the model, depth-first. */
function links(nodes: DocNode[], out: DocContainer[] = []): DocContainer[] {
  for (const n of nodes) {
    if (n.kind === 'container') {
      if (n.type === 'Link') out.push(n);
      links(n.children, out);
    } else if (n.kind === 'list') for (const it of n.items) links(it.blocks, out);
    else if (n.kind === 'listItem') links(n.blocks, out);
  }
  return out;
}

describe('docmodel — link destinations', () => {
  it('carries a URI action as the container href', () => {
    const doc = tagged('See [the docs](https://example.com/a) here.\n');
    const [l] = links(buildDocModel(doc, doc.Pages));
    expect(l).toBeDefined();
    expect(l.href).toBe('https://example.com/a');
  });

  // A GoTo names a page object, not an address; it has no meaningful target
  // once the PDF is gone. The text still renders, so nothing is lost.
  it('leaves an internal GoTo link with no href', () => {
    const doc = Document.New();
    doc.AddMarkdown('Body text.\n', { tagged: true });
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const p = root.Children[0].Children[0];
    const link = p.Append('Link');
    const annot = page.AddLink({
      rect: [10, 10, 100, 30], action: { type: 'goto', page: 1 },
    });
    link.AddAnnotation(annot);
    const re = Document.Open(doc.Save());
    for (const l of links(buildDocModel(re, re.Pages))) expect(l.href).toBeUndefined();
  });
});

describe('ToMarkdown — links', () => {
  it('emits an inline link in the right place in the sentence', () => {
    expect(tagged('See [the docs](https://example.com/a) here.\n').ToMarkdown())
      .toBe('See [the docs](https://example.com/a) here.\n');
  });

  it('escapes a destination that needs it', () => {
    expect(tagged('A [x](https://e.com/a%20b) B\n').ToMarkdown())
      .toContain('[x](https://e.com/a%20b)');
  });

  it('renders a link with no recoverable destination as plain text', () => {
    const doc = Document.New();
    doc.AddMarkdown('Body text.\n', { tagged: true });
    const root = doc.CreateStructTree();
    const p = root.Children[0].Children[0];
    p.Append('Link');   // a /Link with no annotation at all
    const re = Document.Open(doc.Save());
    expect(re.ToMarkdown()).toBe('Body text.\n');
  });
});

describe('ToHtml — links', () => {
  it('emits an href, not a bare anchor', () => {
    const html = tagged('See [the docs](https://example.com/a) here.\n').ToHtml({ fragment: true });
    expect(html).toContain('<a href="https://example.com/a">the docs</a>');
    expect(html).toContain('See <a');
    expect(html).toContain('</a> here.');
  });

  it('escapes the href', () => {
    const html = tagged('A [x](https://e.com/?a=1&b=2) B\n').ToHtml({ fragment: true });
    expect(html).toContain('href="https://e.com/?a=1&amp;b=2"');
  });
});

/** The same source rendered WITHOUT a structure tree: the /Link annotations are
 *  still on the page, but nothing says which words they cover. */
function untagged(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { gfm: true });
  return Document.Open(doc.Save());
}

describe('untagged inference — links from annotation rects', () => {
  it('links the words a /Link annotation covers', () => {
    const md = untagged('See [the docs](https://example.com/a) here.\n').ToMarkdown();
    expect(md).toContain('[the docs](https://example.com/a)');
  });

  it('keeps the surrounding words out of the link', () => {
    const md = untagged('See [the docs](https://example.com/a) here.\n').ToMarkdown();
    expect(md).toContain('See ');
    expect(md).toContain(' here.');
  });

  it('emits an href in untagged HTML too', () => {
    const html = untagged('A [x](https://e.com/q) B\n').ToHtml({ fragment: true });
    expect(html).toContain('href="https://e.com/q"');
  });

  it('leaves a page with no link annotations untouched', () => {
    expect(untagged('Just ordinary text.\n').ToMarkdown()).toBe('Just ordinary text.\n');
  });
});
