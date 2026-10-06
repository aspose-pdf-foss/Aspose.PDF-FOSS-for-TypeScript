import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout, findRanges } from '../src/textedit.js';
import { findParagraph, untaggedKeys, type Paragraph } from '../src/reflowpara.js';
import { buildSimpleTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';

/** findParagraph on a page, anchored at the first glyph of `find`'s first
 *  match, with an always-chained gap rule unless one is given. */
function para(doc: Document, find: string, extra: { gap?: 'none' | 'relative'; annots?: { subtype: string; rect: [number, number, number, number] }[] } = {}) {
  const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
  const [[s]] = findRanges(text, find);
  return findParagraph({
    all, text, refs, covered: new Uint8Array(text.length), keyOf: untaggedKeys(text, refs),
    anchor: refs[s]!, gap: () => extra.gap ?? 'relative', inks, annots: extra.annots ?? [],
  });
}
const block = (text: string, opts: object = {}) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, [72, 500, 200, 200], { fontSize: 12, ...opts });
  return Document.Open(d.Save());
};
const LONG = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';

describe('findParagraph (u3l5.5)', () => {
  it('collects the block holding the anchor into words and lines', () => {
    const p = para(block(LONG), 'lazy') as Paragraph;
    expect(typeof p).toBe('object');
    expect(p.words.map((w) => w.glyphs.map((g) => g.text).join('')).join(' ')).toBe(LONG);
    expect(p.lines.length).toBeGreaterThan(2);
    expect(p.pitch).toBeCloseTo(14.4, 6);
    expect(p.align).toBe('left');
    expect(p.indent).toBe(0);
    expect(p.size).toBe(12);
  });

  it('measures gaps between words on a line and fills line starts with the median', () => {
    const p = para(block(LONG), 'lazy') as Paragraph;
    const space = 278 * 12 / 1000;
    for (let i = 1; i < p.words.length; i++) expect(p.gaps[i]).toBeCloseTo(space, 6);
    expect(p.gaps[0]).toBe(0);
  });

  it('detects justified text and uses the last line for the natural gap', () => {
    const p = para(block(LONG, { align: 'justify' }), 'lazy') as Paragraph;
    expect(p.align).toBe('justify');
    for (let i = 1; i < p.words.length; i++) expect(p.gaps[i]).toBeCloseTo(278 * 12 / 1000, 6);
  });

  it('justified with a one-word last line falls back to the smallest gap', () => {
    // The last line holds "woods" alone (box narrowed so it wraps alone).
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock('aaaa bbbb cccc dddd eeee ffff gggggggggggggggg', [72, 500, 100, 200], { fontSize: 12, align: 'justify' });
    const p = para(Document.Open(d.Save()), 'aaaa') as Paragraph;
    expect(p.align).toBe('justify');
    // The smallest gap actually drawn between two words on one line.
    let smallest = Infinity;
    for (let i = 1; i < p.words.length; i++) {
      if (p.words[i].line !== p.words[i - 1].line) continue;
      const prev = p.words[i - 1].glyphs[p.words[i - 1].glyphs.length - 1];
      smallest = Math.min(smallest, p.words[i].glyphs[0].quad[0] - prev.penEnd[0]);
    }
    expect(Number.isFinite(smallest)).toBe(true);
    for (const g of p.gaps.slice(1)) expect(g).toBeCloseTo(smallest, 6);
  });

  it('detects centred and right-aligned text', () => {
    expect((para(block(LONG, { align: 'center' }), 'lazy') as Paragraph).align).toBe('center');
    expect((para(block(LONG, { align: 'right' }), 'lazy') as Paragraph).align).toBe('right');
  });

  it('a one-line paragraph is left-aligned with a 1.2 x size pitch', () => {
    const p = para(Document.Open(buildSimpleTextPdf('BT /F1 10 Tf 20 250 Td (one line) Tj ET')), 'one') as Paragraph;
    expect(p.align).toBe('left');
    expect(p.pitch).toBeCloseTo(12, 6);
  });

  it('refuses vertical text', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfchar <0041> <0041> endbfchar\n';
    const doc = Document.Open(buildType0Pdf('BT /F1 12 Tf 100 250 Td <00410041> Tj ET', cmap, { encoding: 'Identity-V' }));
    expect(para(doc, 'A')).toBe('vertical');
  });

  it('answers not-found when the anchor has no paragraph key', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (abc) Tj ET'));
    const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
    expect(findParagraph({ all, text, refs, covered: new Uint8Array(text.length), keyOf: () => undefined,
      anchor: refs[0]!, gap: () => 'relative', inks, annots: [] })).toBe('not-found');
  });

  it('refuses rotated text', () => {
    expect(para(Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 0 1 -1 0 100 100 Tm (abc) Tj ET')), 'abc')).toBe('rotated');
  });

  it('refuses a non-member glyph chained to a member', () => {
    // One Tj draws the end of one block and, after a long kern, text far below
    // is impossible in one chain; use two blocks joined by no positioning op.
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 12 Tf 20 250 Td (first para) Tj ET BT /F1 12 Tf 20 150 Td (other) Tj ET'));
    expect(para(doc, 'first', { gap: 'none' })).toBe('interleaved');
  });

  it('refuses foreign ink inside the box', () => {
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 12 Tf 20 250 Td (one two three) Tj 0 -14 Td (four five six) Tj ET 60 240 10 10 re f'));
    expect(para(doc, 'two')).toBe('foreign-ink');
  });

  it('refuses an overlapping annotation it cannot move, and accepts a link', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (one two) Tj ET'));
    expect(para(doc, 'one', { annots: [{ subtype: 'FreeText', rect: [20, 250, 40, 262] }] })).toBe('annotation');
    expect(typeof para(doc, 'one', { annots: [{ subtype: 'Link', rect: [20, 250, 40, 262] }] })).toBe('object');
  });

  it('refuses a varying pitch', () => {
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 12 Tf 20 250 Td (aa bb) Tj 0 -14 Td (cc dd) Tj 0 -18 Td (ee ff) Tj ET'));
    expect(para(doc, 'aa')).toBe('pitch');
  });

  it('refuses glyphs in two scopes', () => {
    // Exercised end to end in test/reflow.test.ts with a form; here the rule
    // itself: a member set spanning paths.
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (aa bb) Tj ET'));
    const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
    const forged = all.map((g, i) => (i === 1 ? { ...g, addr: { ...g.addr, path: ['Fm0'] } } : g));
    const forgedRefs = refs.map((g) => (g === all[1] ? forged[1] : g));
    expect(findParagraph({
      all: forged, text, refs: forgedRefs, covered: new Uint8Array(text.length),
      keyOf: untaggedKeys(text, forgedRefs), anchor: forged[0], gap: () => 'relative', inks, annots: [],
    })).toBe('scopes');
  });
});
