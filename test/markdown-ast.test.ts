import { describe, it, expect } from 'vitest';
import { isMdBlock, isMdInline, isMdContainer, type MdDocument, type MdList } from '../src/mdast.js';
import { parseMarkdown } from '../src/markdown.js';

describe('mdast model', () => {
  it('classifies blocks and inlines', () => {
    expect(isMdBlock({ type: 'paragraph' })).toBe(true);
    expect(isMdBlock({ type: 'emph' })).toBe(false);
    expect(isMdInline({ type: 'emph' })).toBe(true);
    expect(isMdInline({ type: 'paragraph' })).toBe(false);
  });

  it('classifies containers — nodes whose children are blocks', () => {
    for (const t of ['document', 'block_quote', 'list', 'item']) {
      expect(isMdContainer({ type: t }), t).toBe(true);
    }
    for (const t of ['paragraph', 'heading', 'code_block', 'html_block', 'thematic_break', 'emph']) {
      expect(isMdContainer({ type: t }), t).toBe(false);
    }
  });

  it('types a document tree end to end', () => {
    const list: MdList = {
      type: 'list', ordered: true, start: 3, delimiter: ')', tight: false,
      children: [{ type: 'item', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] }] }],
    };
    const doc: MdDocument = { type: 'document', children: [list] };
    expect(doc.children[0]).toBe(list);
  });
});

const firstList = (src: string): MdList => {
  const n = parseMarkdown(src).children.find((c) => c.type === 'list');
  if (n === undefined) throw new Error('no list parsed');
  return n as MdList;
};

/** List shape is largely invisible to an HTML oracle but load-bearing for
 *  gl6o.3: tightness drives paragraph spacing in Flow. */
describe('list model', () => {
  it('marks a list with no blank lines tight', () => {
    expect(firstList('- a\n- b\n').tight).toBe(true);
  });

  it('marks a list with a blank line between items loose', () => {
    expect(firstList('- a\n\n- b\n').tight).toBe(false);
  });

  it('marks a list with a blank line inside one item loose', () => {
    expect(firstList('- a\n\n  b\n').tight).toBe(false);
  });

  it('does not let a trailing blank line make a list loose', () => {
    expect(firstList('- a\n- b\n\n').tight).toBe(true);
  });

  it('keeps an ordered start and delimiter', () => {
    const l = firstList('7) a\n8) b\n');
    expect(l.ordered).toBe(true);
    expect(l.start).toBe(7);
    expect(l.delimiter).toBe(')');
  });

  it('starts a new list when the bullet character changes', () => {
    expect(parseMarkdown('- a\n+ b\n').children.filter((c) => c.type === 'list').length).toBe(2);
  });

  it('nests a list inside a block quote', () => {
    const doc = parseMarkdown('> - a\n');
    expect(doc.children[0].type).toBe('block_quote');
    const bq = doc.children[0] as { children: { type: string }[] };
    expect(bq.children[0].type).toBe('list');
  });
});

describe('link reference definitions', () => {
  it('removes a definition-only paragraph from the tree', () => {
    expect(parseMarkdown('[a]: /u "t"\n').children).toEqual([]);
  });

  it('keeps the paragraph text that follows definitions on the same run', () => {
    const doc = parseMarkdown('[a]: /u\ntext\n');
    expect(doc.children.length).toBe(1);
    expect(doc.children[0].type).toBe('paragraph');
  });

  it('lets the first of two identical labels win', () => {
    // unskip in Task 12, when reference links resolve
    const doc = parseMarkdown('[a]: /first\n[a]: /second\n\n[a]\n');
    const p = doc.children[0] as { children: { destination?: string }[] };
    expect(p.children[0].destination).toBe('/first');
  });

  it('matches a label case-insensitively and across a newline', () => {
    // unskip in Task 12, when reference links resolve
    const doc = parseMarkdown('[Foo\n  bar]: /u\n\n[foo bar]\n');
    const p = doc.children[0] as { children: { destination?: string }[] };
    expect(p.children[0].destination).toBe('/u');
  });
});

describe('links and images', () => {
  it('resolves an inline and a reference link to the same node shape', () => {
    const inline = parseMarkdown('[a](/u "t")\n');
    const ref = parseMarkdown('[a][r]\n\n[r]: /u "t"\n');
    expect(JSON.stringify(inline.children[0])).toBe(JSON.stringify(ref.children[0]));
  });

  it('distinguishes an image from a link', () => {
    const p = parseMarkdown('![a](/i.png)\n').children[0] as { children: { type: string }[] };
    expect(p.children[0].type).toBe('image');
  });

  it('keeps inline structure inside an image description', () => {
    const p = parseMarkdown('![a *b*](/i.png)\n').children[0] as { children: { children: { type: string }[] }[] };
    expect(p.children[0].children.map((c) => c.type)).toEqual(['text', 'emph']);
  });

  it('stores the destination unencoded, for a PDF /URI', () => {
    const p = parseMarkdown('[a](/a%20b?x=1&amp;y=2)\n').children[0] as { children: { destination?: string }[] };
    expect(p.children[0].destination).toBe('/a%20b?x=1&y=2');
  });
});
