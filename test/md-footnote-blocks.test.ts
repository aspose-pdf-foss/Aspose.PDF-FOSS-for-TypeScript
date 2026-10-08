// test/md-footnote-blocks.test.ts
import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../src/mdblock.js';
import type { MdFootnoteDefinition, MdBlock } from '../src/mdast.js';

const lines = (s: string) => s.replace(/\n$/, '').split('\n');
const defs = (children: MdBlock[]) => children.filter((b) => b.type === 'footnote_definition') as MdFootnoteDefinition[];

describe('footnote definitions (block phase, gfm)', () => {
  it('opens a container on [^label]: and parses its first line as a paragraph', () => {
    const { doc } = parseBlocks(lines('[^1]: Some *bold* note.'), true);
    const [d] = defs(doc.children);
    expect(d.label).toBe('1');
    expect(d.children.map((c) => c.type)).toEqual(['paragraph']);
  });
  it('swallows the spaces after the colon (no indented code)', () => {
    const { doc } = parseBlocks(lines('[^n]:       spaces stripped'), true);
    expect(defs(doc.children)[0].children.map((c) => c.type)).toEqual(['paragraph']);
  });
  it('continues on lines indented 4+, through blank lines', () => {
    const { doc } = parseBlocks(lines('[^f]:\n    > quote\n\n        code\n\n    para\n\nafter'), true);
    const [d] = defs(doc.children);
    expect(d.children.map((c) => c.type)).toEqual(['block_quote', 'code_block', 'paragraph']);
    expect(doc.children.map((c) => c.type)).toEqual(['footnote_definition', 'paragraph']);
  });
  it('an 8-space continuation is a code block inside the definition', () => {
    const { doc } = parseBlocks(lines('[^c]:\n        code here'), true);
    expect(defs(doc.children)[0].children.map((c) => c.type)).toEqual(['code_block']);
  });
  it('interrupts a paragraph', () => {
    const { doc } = parseBlocks(lines('text\n[^a]: note'), true);
    expect(doc.children.map((c) => c.type)).toEqual(['paragraph', 'footnote_definition']);
  });
  it('a label may not contain a space, tab or ]', () => {
    for (const src of ['[^a b]: x', '[^a\tb]: x', '[^]: x']) {
      const { doc } = parseBlocks(lines(src), true);
      expect(defs(doc.children)).toHaveLength(0);
    }
  });
  it('only a LITERALLY empty line continues it; a line of spaces closes it (v9j3.3.5)', () => {
    // cmark-gfm parse_footnote_definition_block_prefix tests `data[0] == '\n'`.
    const { doc } = parseBlocks(lines('[^f]: a\n  \n    b'), true);
    expect(doc.children.map((c) => c.type)).toEqual(['footnote_definition', 'code_block']);
    expect(defs(doc.children)[0].children.map((c) => c.type)).toEqual(['paragraph']);
    // …while a truly empty line keeps it open.
    const open = parseBlocks(lines('[^f]: a\n\n    b'), true).doc;
    expect(open.children.map((c) => c.type)).toEqual(['footnote_definition']);
    expect(defs(open.children)[0].children.map((c) => c.type)).toEqual(['paragraph', 'paragraph']);
  });
  it('opens at most 99 definitions on one line: cmark-gfm MAX_LIST_DEPTH (v9j3.3.5)', () => {
    let d: MdFootnoteDefinition | undefined = defs(parseBlocks(lines('[^a]:'.repeat(120) + ' text'), true).doc.children)[0];
    let depth = 0;
    let last: MdFootnoteDefinition | undefined;
    while (d !== undefined) { depth++; last = d; d = defs(d.children)[0]; }
    expect(depth).toBe(99);
    expect(last!.children.map((c) => c.type)).toEqual(['paragraph']);   // the rest is text
    // The bound is per LINE, not nesting: a definition on its own line still
    // opens inside 99 open ones.
    const deep = '[^a]:'.repeat(99) + '\n' + '    '.repeat(99) + '[^b]: x';
    const top = defs(parseBlocks(lines(deep), true).doc.children)[0];
    let n = 0;
    for (let e: MdFootnoteDefinition | undefined = top; e !== undefined; e = defs(e.children)[0]) n++;
    expect(n).toBe(100);
  });
  it('a definition may hold a definition', () => {
    const { doc } = parseBlocks(lines('[^a]:[^b]:'), true);
    const [a] = defs(doc.children);
    expect(defs(a.children).map((d) => d.label)).toEqual(['b']);
  });
  it('is inert with gfm off: the line is a paragraph (a link reference attempt)', () => {
    const { doc } = parseBlocks(lines('[^1]: note'), false);
    expect(defs(doc.children)).toHaveLength(0);
  });
  it('an indented [^x]: is not a definition', () => {
    const { doc } = parseBlocks(lines('    [^x]: note'), true);
    expect(defs(doc.children)).toHaveLength(0);
  });
});
