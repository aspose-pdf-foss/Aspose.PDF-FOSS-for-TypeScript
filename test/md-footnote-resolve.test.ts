// test/md-footnote-resolve.test.ts
import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import type { MdInline, MdBlock, MdDocument } from '../src/mdast.js';

function refs(doc: MdDocument) {
  const out: { label: string; index: number; occurrence: number }[] = [];
  const inl = (ns: MdInline[]) => ns.forEach((n) => {
    if (n.type === 'footnote_reference') out.push({ label: n.label, index: n.index, occurrence: n.occurrence });
    if ('children' in n) inl(n.children as MdInline[]);
  });
  const blk = (bs: MdBlock[]) => bs.forEach((b) => {
    if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'table_cell') inl(b.children);
    else if ('children' in b) blk(b.children as MdBlock[]);
  });
  blk(doc.children);
  for (const d of doc.footnotes ?? []) blk(d.children);
  return out;
}
const md = (s: string) => parseMarkdown(s, { gfm: true });

describe('resolveFootnotes', () => {
  it('numbers by first citation and counts occurrences', () => {
    const doc = md('a[^x] b[^y] c[^x]\n\n[^y]: Y\n[^x]: X\n');
    expect(refs(doc)).toEqual([
      { label: 'x', index: 1, occurrence: 1 },
      { label: 'y', index: 2, occurrence: 1 },
      { label: 'x', index: 1, occurrence: 2 },
    ]);
    expect(doc.footnotes!.map((d) => [d.label, d.index, d.references])).toEqual([['x', 1, 2], ['y', 2, 1]]);
  });
  it('removes every definition from the tree, cited or not', () => {
    const doc = md('t[^a]\n\n> [^a]: A\n\n[^unused]: U\n');
    expect(JSON.stringify(doc.children)).not.toContain('footnote_definition');
    expect(doc.footnotes!.map((d) => d.label)).toEqual(['a']);
  });
  it('an undefined reference is the literal source text', () => {
    const doc = md('x[^~~is~~1] y\n');
    expect(JSON.stringify(doc.children)).toContain('[^~~is~~1]');
    expect(doc.footnotes).toBeUndefined();
  });
  it('matches labels by case fold and collapsed whitespace (Review Focus 3)', () => {
    const doc = md('t[^Note]\n\n[^note]: n\n');
    expect(refs(doc)[0]).toMatchObject({ index: 1, label: 'note' });   // the DEFINITION's spelling
  });
  it('the first definition of a label wins', () => {
    const doc = md('t[^a]\n\n[^a]: first\n\n[^a]: second\n');
    expect(JSON.stringify(doc.footnotes)).toContain('first');
    expect(JSON.stringify(doc.footnotes)).not.toContain('second');
  });
  it('numbers in TREE order: a citation inside an earlier definition counts where that definition sits', () => {
    // cmark-gfm process_footnotes walks the tree with definitions still in place.
    const doc = md('[^a]: A cites[^b]\n\nlater[^a] and[^c]\n\n[^b]: B\n[^c]: C\n');
    const order = doc.footnotes!.map((d) => d.label);
    expect(order).toEqual(['b', 'a', 'c']);
  });
  it('a reference longer than 1000 characters is literal', () => {
    const long = 'x'.repeat(1001);
    const doc = md(`t[^${long}]\n\n[^${long}]: n\n`);
    expect(doc.footnotes).toBeUndefined();
  });
  it('gfm off produces no footnotes field', () => {
    expect(parseMarkdown('t[^a]\n\n[^a]: n\n').footnotes).toBeUndefined();
  });
});
