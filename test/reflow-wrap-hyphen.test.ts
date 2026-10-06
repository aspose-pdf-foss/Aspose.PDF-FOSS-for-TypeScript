import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout, findRanges } from '../src/textedit.js';
import { findParagraph, untaggedKeys, type Paragraph } from '../src/reflowpara.js';
import { wrapParagraph, type HyphenWrap, type WrapUnit } from '../src/reflowwrap.js';
import { glyphAdvance } from '../src/replaceadjust.js';
import { hyphenator, resolveHyphenation, type Hyphenator } from '../src/hyphenate.js';
import type { GlyphEvent } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const block = (text: string, box = BOX[2]) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, [BOX[0], BOX[1], box, BOX[3]], { fontSize: 12 });
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
const plain = (h: Hyphenator, over: Map<GlyphEvent, WrapUnit[]> = new Map()): HyphenWrap => ({
  hyphenator: h, manual: false,
  unitsOf: (g) => over.get(g) ?? [{ text: g.text, width: glyphAdvance(g), hyphen: 12 * 0.333 }],
  canSuppress: () => false,
});
const none: Hyphenator = { points: () => [] };
const en = hyphenator(resolveHyphenation({ lang: 'en' }));
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';

describe('wrapParagraph with hyphenate (6y39)', () => {
  it('with no points, places every glyph exactly as the atomic path', () => {
    const doc = block(T);
    const p = paraOf(doc, 'quick');
    const k = wordIndex(p, 'quick');
    const quick = p.words[k].glyphs;
    const adv = (g: GlyphEvent) => (g === quick[0] ? glyphAdvance(g) * 4 : glyphAdvance(g));
    const a = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k });
    const over = new Map<GlyphEvent, WrapUnit[]>(quick.map((g) => [g, [{ text: g.text, width: adv(g), hyphen: 4 }]]));
    const b = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k, hyphen: plain(none, over) });
    for (const [g, t] of a.targets) { expect(b.targets.get(g)![0]).toBeCloseTo(t[0], 9); expect(b.targets.get(g)![1]).toBeCloseTo(t[1], 9); }
    expect(b.addedLines).toBe(a.addedLines);
    expect(b.breaks).toEqual([]);
  });

  it('breaks a long word at a pattern point and reports it', () => {
    const doc = block('Some text about internationalization that is long', 150);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'Some');
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: plain(en) });
    expect(r.breaks.length).toBeGreaterThan(0);
    const br = r.breaks[0];
    const word = p.words[wordIndex(p, 'internationalization')].glyphs;
    const at = word.indexOf(br.glyph);
    expect(at).toBeGreaterThan(0);
    // The glyph after the break starts the next line, at the box's left.
    const next = r.targets.get(word[at + 1])!;
    expect(next[1]).toBeLessThan(r.targets.get(br.glyph)![1]);
    expect(next[0]).toBeCloseTo(p.lines[1]?.left ?? p.lines[0].left, 6);
    // Its box carries the hyphen.
    const box = r.boxes.get(br.glyph)!;
    expect(box[0].width).toBeCloseTo(glyphAdvance(br.glyph) + 12 * 0.333, 6);
  });

  it('skips a point whose unit has no hyphen face', () => {
    const doc = block('Some text about internationalization that is long', 150);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'Some');
    const noFace: HyphenWrap = { ...plain(en), unitsOf: (g) => [{ text: g.text, width: glyphAdvance(g) }] };
    expect(wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: noFace }).breaks).toEqual([]);
  });

  it('drops a point inside a multi-character unit (a ligature)', () => {
    const doc = block('Some text about internationalization that is long', 150);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'Some');
    const word = p.words[wordIndex(p, 'internationalization')].glyphs;
    const pts = en.points('internationalization');
    expect(pts.length).toBeGreaterThan(0);
    // Fuse the two glyphs around EVERY pattern point into one unit: no point
    // survives on a unit boundary inside the word.
    const over = new Map<GlyphEvent, WrapUnit[]>();
    for (const q of pts) {
      over.set(word[q - 1], [{ text: word[q - 1].text + word[q].text, width: glyphAdvance(word[q - 1]) + glyphAdvance(word[q]), hyphen: 4 }]);
      over.set(word[q], []);
    }
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: plain(en, over) });
    expect(r.breaks.filter((b) => word.includes(b.glyph))).toEqual([]);
  });

  it('a break inside a multi-unit glyph reports the tail origin', () => {
    // One glyph stands for a whole edit: its units are characters.
    const doc = block('Some text about internationalization that is long', 150);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'about');
    const g0 = p.words[k].glyphs[0];
    const units: WrapUnit[] = [...'internationalization'].map((c) => ({ text: c, width: 7, hyphen: 4 }));
    const over = new Map<GlyphEvent, WrapUnit[]>([[g0, units], ...p.words[k].glyphs.slice(1).map((g) => [g, [] as WrapUnit[]] as const)]);
    const r = wrapParagraph({ para: p, advanceOf: (g) => (g === g0 ? 140 : over.has(g) ? 0 : glyphAdvance(g)), firstEdited: k, lastEdited: k, hyphen: plain(en, over) });
    const br = r.breaks.find((b) => b.glyph === g0)!;
    expect(br.tail).toBeDefined();
    expect(br.tail![1]).toBeLessThan(r.targets.get(g0)![1]);
    expect(r.boxes.get(g0)!.length).toBe(2);
  });

  it('a word with no break opportunity is not split by UAX #14 (proxies are AL)', () => {
    const doc = block('Some text about internationalization that is long', 40);
    const p = paraOf(doc, 'Some');
    const k = wordIndex(p, 'Some');
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: plain(none) });
    const word = p.words[wordIndex(p, 'internationalization')].glyphs;
    const ys = new Set(word.map((g) => r.targets.get(g)![1]));
    expect(ys.size).toBe(1);   // drawn whole, overflowing, as today
  });
});

const para = (lines: string[]) => Document.Open(buildSimpleTextPdf(
  `BT /F1 12 Tf 20 280 Td (${lines[0]}) Tj ${lines.slice(1).map((l) => `0 -14 Td (${l}) Tj`).join(' ')} ET`));
const join = (h: Hyphenator): HyphenWrap => ({ ...plain(h), canSuppress: () => true });

describe('rejoin (6y39)', () => {
  // A soft hyphen (WinAnsi 0xAD, written \255 in the PDF string) is provably a
  // break. A drawn '-' is not: the patterns allow well|known, self|evident and
  // co|operate, so they cannot tell an inserted break from a compound's own
  // hyphen, and a drawn '-' is never removed.
  const SHY = '\u00AD';
  const shrinkAlpha = (doc: Document, h: HyphenWrap = join(en)) => {
    const p = paraOf(doc, 'alpha');
    const k = wordIndex(p, 'alpha');
    const alpha = p.words[k].glyphs;
    const adv = (g: GlyphEvent) => (alpha.includes(g) ? 0.1 : glyphAdvance(g));
    const r = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k,
      hyphen: { ...h, unitsOf: (g) => [{ text: g.text, width: adv(g), hyphen: 4 }] } });
    return { p, r };
  };
  it('suppresses a line-end soft hyphen once both halves share a line', () => {
    const { p, r } = shrinkAlpha(para(['alpha docu\\255', 'mentation beta', 'gamma delta']));
    const h = p.words[wordIndex(p, `docu${SHY}`)].glyphs.at(-1)!;
    expect(h.text).toBe(SHY);
    expect(r.suppressed).toEqual([h]);
    expect(r.targets.has(h)).toBe(false);
    const m = p.words[wordIndex(p, 'mentation')].glyphs[0];
    const u = p.words[wordIndex(p, `docu${SHY}`)].glyphs.at(-2)!;
    expect(r.targets.get(m)![1]).toBeCloseTo(r.targets.get(u)![1], 6);
    expect(r.targets.get(m)![0]).toBeCloseTo(r.targets.get(u)![0] + glyphAdvance(u), 6);
  });
  it('never suppresses a drawn hyphen, even where the patterns break', () => {
    expect(en.points('wellknown')).toContain(4);   // the compound the rule protects
    for (const lines of [['alpha docu-', 'mentation beta', 'gamma delta'], ['alpha well-', 'known beta', 'gamma delta']]) {
      expect(shrinkAlpha(para(lines)).r.suppressed).toEqual([]);
    }
  });
  it('keeps the soft hyphen (no insert) when the line still breaks there', () => {
    const doc = para(['alpha docu\\255', 'mentation beta', 'gamma delta']);
    const p = paraOf(doc, 'beta');
    const k = wordIndex(p, 'beta');
    const r = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k, hyphen: join(en) });
    expect(r.suppressed).toEqual([]);
  });
  it('does not rejoin before an uppercase word', () => {
    expect(shrinkAlpha(para(['alpha docu\\255', 'Mentation beta'])).r.suppressed).toEqual([]);
  });
  it('rejoins a soft hyphen in manual mode too', () => {
    const manual = hyphenator(resolveHyphenation({ mode: 'manual' }));
    // A wide third line leaves room to join: manual mode has no other point.
    const { r } = shrinkAlpha(para(['alpha docu\\255', 'mentation beta', 'gamma delta epsilon zeta eta']), { ...join(manual), manual: true });
    expect(r.suppressed.length).toBe(1);
  });
  it('a rejoinable pair wholly past convergence keeps its hyphen', () => {
    const doc = para(['alpha beta gamma', 'delta epsilon', 'zeta docu\\255', 'mentation eta']);
    const p = paraOf(doc, 'alpha');
    const k = wordIndex(p, 'alpha');
    const a0 = p.words[k].glyphs[0];
    // One point narrower: line 0 keeps its words, so line 1 converges.
    const adv = (g: GlyphEvent) => (g === a0 ? glyphAdvance(g) - 1 : glyphAdvance(g));
    const r = wrapParagraph({ para: p, advanceOf: adv, firstEdited: k, lastEdited: k,
      hyphen: { ...join(en), unitsOf: (g) => [{ text: g.text, width: adv(g), hyphen: 4 }] } });
    expect(r.addedLines).toBe(0);
    const h = p.words[wordIndex(p, `docu${SHY}`)].glyphs.at(-1)!;
    expect(r.suppressed).toEqual([]);
    expect(r.targets.get(h)).toEqual([h.quad[0], h.quad[1]]);
  });
  it('never suppresses what canSuppress refuses', () => {
    expect(shrinkAlpha(para(['alpha docu\\255', 'mentation beta', 'gamma delta']), plain(en)).r.suppressed).toEqual([]);
  });
});
