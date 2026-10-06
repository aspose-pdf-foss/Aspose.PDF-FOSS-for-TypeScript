import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout, findRanges } from '../src/textedit.js';
import { findParagraph, untaggedKeys, type Paragraph } from '../src/reflowpara.js';
import { wrapParagraph } from '../src/reflowwrap.js';
import { glyphAdvance } from '../src/replaceadjust.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const block = (text: string, opts: { box?: number; align?: 'left' | 'justify' | 'center' | 'right' } = {}) => {
  const d = Document.New(PageFormat.A4);
  const { box, ...rest } = opts;
  d.Pages[0].AddTextBlock(text, [BOX[0], BOX[1], box ?? BOX[2], BOX[3]], { fontSize: 12, ...rest });
  return Document.Open(d.Save());
};
function paraOf(doc: Document, anchorText: string): Paragraph {
  const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
  const [[s]] = findRanges(text, anchorText);
  const p = findParagraph({ all, text, refs, covered: new Uint8Array(text.length), keyOf: untaggedKeys(text, refs),
    anchor: refs[s]!, gap: () => 'relative', inks, annots: [] });
  if (typeof p === 'string') throw new Error(p);
  return p;
}
const wordIndex = (p: Paragraph, w: string) => p.words.findIndex((x) => x.glyphs.map((g) => g.text).join('') === w);

describe('wrapParagraph (u3l5.5)', () => {
  const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';

  it('reproduces the producer when nothing changes width', () => {
    const doc = block(T);
    const p = paraOf(doc, 'lazy');
    const k = wordIndex(p, 'lazy');
    const { targets, addedLines } = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k });
    expect(addedLines).toBe(0);
    // Word glyphs only: a space glyph is a gap, not part of any word, and gets
    // no target — the writer lets it ride along its pen chain.
    for (const w of p.words) for (const g of w.glyphs) {
      expect(targets.get(g)![0]).toBeCloseTo(g.quad[0], 6);
      expect(targets.get(g)![1]).toBeCloseTo(g.quad[1], 6);
    }
  });

  it('matches AddTextBlock of the new text when a word grows', () => {
    // "quick" made four times as wide, the shape an edit has: the word's first
    // glyph carries the whole new width and its other glyphs 0.
    const doc = block(T);
    const p = paraOf(doc, 'quick');
    const k = wordIndex(p, 'quick');
    const quick = p.words[k].glyphs;
    const wide = 4 * quick.reduce((s, x) => s + glyphAdvance(x), 0);
    const { targets } = wrapParagraph({
      para: p, firstEdited: k, lastEdited: k,
      advanceOf: (g) => (g === quick[0] ? wide : quick.includes(g) ? 0 : glyphAdvance(g)),
    });
    // Every word after "quick" starts where AddTextBlock of the grown text
    // starts it.
    // starts it — in the box the paragraph MEASURES, its widest line: a
    // producer's box wider than that is not recoverable from the page.
    const measured = Math.max(...p.lines.map((l) => l.right)) - BOX[0] + 1e-3;
    const grown = paraOf(block(T.replace('quick', 'quickquickquickquick'), { box: measured }), 'brown');
    const expected = grown.words.slice(k + 1).map((w) => [w.glyphs[0].quad[0], w.glyphs[0].quad[1]]);
    const after = p.words.slice(k + 1).map((w) => targets.get(w.glyphs[0])!);
    expect(after.length).toBe(expected.length);
    after.forEach(([x, y], i) => { expect(x).toBeCloseTo(expected[i][0], 3); expect(y).toBeCloseTo(expected[i][1], 3); });
  });

  it('an over-wide word sits alone, overflowing, without throwing', () => {
    const doc = block(T);
    const p = paraOf(doc, 'fox');
    const k = wordIndex(p, 'fox');
    const fox0 = p.words[k].glyphs[0];
    const r = wrapParagraph({ para: p, firstEdited: k, lastEdited: k,
      advanceOf: (g) => (g === fox0 ? 500 : p.words[k].glyphs.includes(g) ? 0 : glyphAdvance(g)) });
    const fx = r.targets.get(fox0)!;
    const prevWord = p.words[k - 1].glyphs[0];
    expect(fx[1]).toBeLessThan(r.targets.get(prevWord)![1]);   // its own, lower line
    expect(fx[0]).toBeCloseTo(BOX[0], 6);
  });

  it('stops at convergence: later lines keep their breaks and move by the added lines', () => {
    // Four producer lines at a 14pt pitch. Line 0 sets the box; line 2 is one
    // long word that "ffff" cannot join. Growing "eeee" pushes "ffff" onto a
    // line of its own, so line 2 starts the line after that: a new break on
    // an original one, one line down. Line 3 is short enough that a greedy
    // re-wrap would pull "i" up beside the long word: only convergence keeps
    // the producer's break there.
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 280 Td (aaaa bbbb cccc dddd) Tj 0 -14 Td (eeee ffff) Tj '
      + '0 -14 Td (gggggggggggggggg) Tj 0 -14 Td (i jj) Tj ET'));
    const p = paraOf(doc, 'eeee');
    const k = wordIndex(p, 'eeee');
    const e0 = p.words[k].glyphs[0];
    const r = wrapParagraph({ para: p, firstEdited: k, lastEdited: k,
      advanceOf: (g) => (g === e0 ? p.words[k].glyphs.reduce((s, x) => s + glyphAdvance(x), 0) + 80 : p.words[k].glyphs.includes(g) ? 0 : glyphAdvance(g)) });
    expect(r.addedLines).toBe(1);
    const f = p.words[wordIndex(p, 'ffff')].glyphs[0];
    expect(r.targets.get(f)).toEqual([20, 280 - 2 * 14]);
    for (const l of p.lines.slice(2)) {
      const g = p.words[l.first].glyphs[0];
      expect(r.targets.get(g)![0]).toBeCloseTo(g.quad[0], 6);
      expect(r.targets.get(g)![1]).toBeCloseTo(g.quad[1] - p.pitch, 6);
    }
    // Line 0 is before the edit and keeps its place.
    const a = p.words[0].glyphs[0];
    expect(r.targets.get(a)).toEqual([a.quad[0], a.quad[1]]);
  });

  it('spreads justified lines and leaves the last line natural', () => {
    const doc = block(T, { align: 'justify' });
    const p = paraOf(doc, 'lazy');
    const k = wordIndex(p, 'lazy');
    const { targets } = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k });
    for (const g of p.members) if (g.text && g.text !== ' ') expect(targets.get(g)![0]).toBeCloseTo(g.quad[0], 3);
  });
});
