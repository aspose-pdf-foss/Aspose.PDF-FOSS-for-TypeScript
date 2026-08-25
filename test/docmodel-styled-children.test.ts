import { describe, it, expect } from 'vitest';
import { styledChildren } from '../src/docmodel.js';
import type { DocContainer, DocNode, DocText } from '../src/docmodel.js';

const t = (text: string, style: Partial<DocText> = {}): DocText =>
  ({ kind: 'text', text, ...style });
const box = (type: string, children: DocNode[]): DocContainer =>
  ({ kind: 'container', type, children });

/** Just the text nodes, as [text, bold?, italic?, script?] tuples. */
const shape = (nodes: DocNode[]) => nodes.map((n) =>
  n.kind === 'text' ? [n.text, n.bold, n.italic, n.script] : n.kind);

describe('styledChildren — merging adjacent runs', () => {
  it('merges two adjacent runs sharing a style', () => {
    // Required, not cosmetic: emitted separately these give Markdown
    // `**a****b**`, a four-asterisk delimiter run that does not reparse as two
    // strong spans. struct.ts splits per MCID, so this is the normal case.
    const out = styledChildren(box('P', [t('a', { bold: true }), t('b', { bold: true })]));
    expect(shape(out)).toEqual([['ab', true, undefined, undefined]]);
  });

  it('does not merge runs whose styles differ', () => {
    const out = styledChildren(box('P', [t('a', { bold: true }), t('b', { italic: true })]));
    expect(shape(out)).toEqual([['a', true, undefined, undefined], ['b', undefined, true, undefined]]);
  });

  it('merges plain runs too', () => {
    expect(shape(styledChildren(box('P', [t('a'), t('b')]))))
      .toEqual([['ab', undefined, undefined, undefined]]);
  });

  it('does not merge across a non-text sibling', () => {
    const out = styledChildren(box('P', [t('a', { bold: true }), box('Link', []), t('b', { bold: true })]));
    expect(shape(out)).toEqual([['a', true, undefined, undefined], 'container', ['b', true, undefined, undefined]]);
  });

  it('distinguishes script when merging', () => {
    const out = styledChildren(box('P', [t('a', { script: 'super' }), t('b')]));
    expect(shape(out)).toEqual([['a', undefined, undefined, 'super'], ['b', undefined, undefined, undefined]]);
  });
});

describe('styledChildren — heading bold suppression', () => {
  it('drops bold when every run in a heading has it', () => {
    // mdstyle defaults headings to Helvetica-Bold, so without this our own
    // `# Title` round-trips as `# **Title**`.
    const out = styledChildren(box('H1', [t('Title', { bold: true })]));
    expect(shape(out)).toEqual([['Title', undefined, undefined, undefined]]);
  });

  it('drops it through a nested container too', () => {
    // The heading rule spans the SUBTREE: a bold run inside a Link inside a
    // uniformly bold heading is still baseline typography.
    const out = styledChildren(box('H2', [box('Link', [t('Title', { bold: true })])]));
    const link = out[0] as DocContainer;
    expect(shape(link.children)).toEqual([['Title', undefined, undefined, undefined]]);
  });

  it('KEEPS bold when only some of the heading is bold', () => {
    // The case that stops the rule collapsing into "headings never emphasize".
    const out = styledChildren(box('H1', [t('plain '), t('bold', { bold: true })]));
    expect(shape(out)).toEqual([
      ['plain ', undefined, undefined, undefined],
      ['bold', true, undefined, undefined],
    ]);
  });

  it('keeps italic in a uniformly italic heading', () => {
    // Neither format supplies italic to a heading, so suppressing it would
    // simply lose information.
    expect(shape(styledChildren(box('H1', [t('T', { italic: true })]))))
      .toEqual([['T', undefined, true, undefined]]);
  });

  it('does NOT suppress bold in a uniformly bold paragraph', () => {
    // A paragraph set entirely in bold IS a distinction the document is making.
    expect(shape(styledChildren(box('P', [t('all', { bold: true })]))))
      .toEqual([['all', true, undefined, undefined]]);
  });

  it('treats a heading with no text as not-uniformly-bold', () => {
    // `every` over an empty set is vacuously true, which would make this branch
    // fire on a heading holding only a figure. Harmless today, wrong in spirit.
    const out = styledChildren(box('H1', [box('Figure', [])]));
    expect(out).toHaveLength(1);
  });
});
