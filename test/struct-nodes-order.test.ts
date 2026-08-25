import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { StructElement, type StructNode } from '../src/struct.js';

/** A tagged document from Markdown, reopened from its own bytes. */
function tagged(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { tagged: true, gfm: true });
  return Document.Open(doc.Save());
}

/** The first element of `type` anywhere in the tree. */
function find(doc: Document, type: string): StructElement | undefined {
  const root = doc.GetStructTree();
  if (!root) return undefined;
  const walk = (el: StructElement): StructElement | undefined => {
    if (el.StandardType === type) return el;
    for (const c of el.Children) { const hit = walk(c); if (hit) return hit; }
    return undefined;
  };
  for (const c of root.Children) { const hit = walk(c); if (hit) return hit; }
  return undefined;
}

/** Nodes as a readable shape: own text verbatim, a child as <Type>. */
const shape = (ns: StructNode[]): string[] =>
  ns.map((n) => (n instanceof StructElement ? `<${n.StandardType}>` : n.text));

describe('StructElement.Nodes — interleaving own text with a nested child', () => {
  // A /Link's marked content is nested INSIDE its paragraph's, so the
  // paragraph's own glyphs sit on both sides of it in the content stream. The
  // parent's text must split around the child rather than being emitted whole
  // and the child appended, which relocates the link to the end of the sentence.
  it('splits the paragraph text around a link in the middle', () => {
    const p = find(tagged('See [the docs](https://example.com/a) here.\n'), 'P')!;
    expect(shape(p.Nodes)).toEqual(['See ', '<Link>', 'here.']);
  });

  it('keeps a leading link first and the text after it', () => {
    const p = find(tagged('[Docs](https://example.com) explain it.\n'), 'P')!;
    expect(shape(p.Nodes)).toEqual(['<Link>', 'explain it.']);
  });

  it('keeps a trailing link last', () => {
    const p = find(tagged('Read the [docs](https://example.com)\n'), 'P')!;
    expect(shape(p.Nodes)).toEqual(['Read the ', '<Link>']);
  });

  it('splits around two links in one paragraph, in reading order', () => {
    const p = find(tagged('A [one](https://e.com/1) B [two](https://e.com/2) C\n'), 'P')!;
    expect(shape(p.Nodes)).toEqual(['A ', '<Link>', 'B ', '<Link>', 'C']);
  });

  it('leaves a paragraph with no child element exactly as it was', () => {
    const p = find(tagged('Just ordinary text.\n'), 'P')!;
    expect(shape(p.Nodes)).toEqual(['Just ordinary text.']);
  });
});
