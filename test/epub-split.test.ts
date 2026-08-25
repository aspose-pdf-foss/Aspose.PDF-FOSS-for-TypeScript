import { describe, it, expect } from 'vitest';
import { splitChapters } from '../src/epubsplit.js';
import type { DocNode } from '../src/docmodel.js';

/** A container holding one text run — a heading or a paragraph. */
const el = (type: string, text: string): DocNode =>
  ({ kind: 'container', type, children: [{ kind: 'text', text }] });

/** A wrapper container, the shape both tagged paths produce. */
const wrap = (type: string, children: DocNode[]): DocNode =>
  ({ kind: 'container', type, children });

const titles = (nodes: DocNode[]) => splitChapters(nodes, 'Doc').map((c) => c.title);

describe('splitChapters', () => {
  it('splits at H1 when an H1 is present', () => {
    const body = [
      el('H1', 'One'), el('P', 'alpha'),
      el('H1', 'Two'), el('P', 'beta'),
    ];
    const chapters = splitChapters(body, 'Doc');
    expect(chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(chapters[0].nodes).toHaveLength(2);
  });

  it('splits at H2 when the document has no H1', () => {
    // The reason the level is derived rather than fixed: our own extraction
    // produces H2-rooted documents, which an "H1 only" rule never splits.
    expect(titles([
      el('H2', 'Alpha'), el('P', 'a'),
      el('H2', 'Beta'), el('P', 'b'),
    ])).toEqual(['Alpha', 'Beta']);
  });

  it('keeps a deeper heading inside its own chapter', () => {
    const chapters = splitChapters([
      el('H1', 'One'), el('H2', 'Sub'), el('P', 'a'),
      el('H1', 'Two'),
    ], 'Doc');
    expect(chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(chapters[0].nodes).toHaveLength(3);   // H1 + H2 + P
  });

  it('gives content before the first heading its own chapter', () => {
    // Dropping it would lose content, which this codebase never does.
    const chapters = splitChapters([
      el('P', 'front matter'),
      el('H1', 'One'), el('P', 'a'),
    ], 'Doc');
    expect(chapters.map((c) => c.title)).toEqual(['Doc', 'One']);
    expect(chapters[0].nodes).toHaveLength(1);
  });

  it('yields exactly one chapter when there are no headings', () => {
    const chapters = splitChapters([el('P', 'a'), el('P', 'b')], 'Doc');
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Doc');
    expect(chapters[0].nodes).toHaveLength(2);
  });

  it('descends through a lone wrapper and re-wraps each chapter', () => {
    // Both tagged paths bury everything under a single Sect or Document, so a
    // top-level-only split would yield ONE chapter for every tagged PDF.
    const chapters = splitChapters([
      wrap('Sect', [el('H1', 'One'), el('P', 'a'), el('H1', 'Two')]),
    ], 'Doc');
    expect(chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    const first = chapters[0].nodes[0];
    expect(first.kind).toBe('container');
    expect(first.kind === 'container' && first.type).toBe('Sect');
  });

  it('preserves the wrapper\'s lang when re-wrapping', () => {
    const sect: DocNode = {
      kind: 'container', type: 'Sect', lang: 'fr',
      children: [el('H1', 'Un'), el('H1', 'Deux')],
    };
    const first = splitChapters([sect], 'Doc')[0].nodes[0];
    expect(first.kind === 'container' && first.lang).toBe('fr');
  });

  it('yields one chapter for an empty document rather than none', () => {
    expect(splitChapters([], 'Doc')).toHaveLength(1);
  });
});
