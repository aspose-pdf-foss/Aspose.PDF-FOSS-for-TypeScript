// test/md-footnote-inlines.test.ts
import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../src/mdblock.js';
import { parseInlines } from '../src/mdinline.js';
import type { MdParagraph } from '../src/mdast.js';

function inl(src: string, gfm = true) {
  const { doc, refs } = parseBlocks(src.split('\n'), gfm);
  parseInlines(doc, refs, gfm);
  return (doc.children[0] as MdParagraph).children;
}

describe('footnote references (inline phase, gfm)', () => {
  it('[^label] becomes a placeholder reference', () => {
    expect(inl('a[^1] b')).toEqual([
      { type: 'text', value: 'a' },
      { type: 'footnote_reference', label: '1', index: 0, occurrence: 0 },
      { type: 'text', value: ' b' },
    ]);
  });
  it('the label is the RAW text between [^ and ], whatever parsed inside', () => {
    const n = inl('x[^~~is~~1]').find((k) => k.type === 'footnote_reference');
    expect(n).toMatchObject({ label: '~~is~~1' });
  });
  it('[^] alone is not a reference', () => {
    expect(inl('a[^]').some((k) => k.type === 'footnote_reference')).toBe(false);
  });
  it('a link wins: [^x](url) is a link', () => {
    expect(inl('[^x](http://a.b)')[0]).toMatchObject({ type: 'link' });
  });
  it('![^1] is a bang then a reference, never an image', () => {
    const ns = inl('a![^1]');
    expect(ns.map((n) => n.type)).toEqual(['text', 'footnote_reference']);
    expect((ns[0] as { value: string }).value).toBe('a!');
  });
  it('two references side by side', () => {
    expect(inl('x[^a][^b]').filter((k) => k.type === 'footnote_reference')).toHaveLength(2);
  });
  it('emphasis around a reference still closes', () => {
    expect(inl('*a[^1]*')[0]).toMatchObject({ type: 'emph' });
  });
  it('is inert with gfm off', () => {
    expect(inl('a[^1] b', false).some((k) => k.type === 'footnote_reference')).toBe(false);
  });
  it('resolves inside a definition body too', () => {
    const { doc, refs } = parseBlocks(['[^a]: see[^b]'], true);
    parseInlines(doc, refs, true);
    const def = doc.children[0] as { children: MdParagraph[] };
    expect(def.children[0].children.some((k) => k.type === 'footnote_reference')).toBe(true);
  });
});
