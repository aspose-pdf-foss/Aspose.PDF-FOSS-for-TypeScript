import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout } from '../src/textedit.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { hyphenator, resolveHyphenation } from '../src/hyphenate.js';
import type { StructElement } from '../src/struct.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const LONG = 'Documentation of internationalization requirements demonstrates extraordinary responsibility and considerable organizational flexibility throughout implementation';
type Align = 'left' | 'justify';
const block = (text: string, o: { align?: Align; width?: number; hyphenate?: boolean } = {}) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, [BOX[0], BOX[1], o.width ?? BOX[2], BOX[3]],
    { fontSize: 12, align: o.align, ...(o.hyphenate ? { hyphenate: { lang: 'en' } } : {}) });
  return Document.Open(d.Save());
};
const measured = (doc: Document) =>
  Math.max(...doc.Pages[0].GetStructuredText().flatMap((b) => b.lines.map((l) => l.quad[2]))) - BOX[0] + 1e-3;
const unit = (s: string) => s.replace(/ /g, ' ');
const origins = (doc: Document) => {
  const { text, refs } = pageLayout(doc, doc.Pages[0], {});
  const out: [string, number, number][] = [];
  let last;
  for (let i = 0; i < text.length; i++) {
    const g = refs[i];
    if (!g || g === last || g.text.trim() === '') continue;
    last = g;
    out.push([g.text, g.quad[0], g.quad[1]]);
  }
  return out;
};
const same = (a: [string, number, number][], b: [string, number, number][]) => {
  expect(a.map((x) => x[0]).join('')).toBe(b.map((x) => x[0]).join(''));
  a.forEach((x, i) => { expect(x[1]).toBeCloseTo(b[i][1], 3); expect(x[2]).toBeCloseTo(b[i][2], 3); });
};
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };
/** An inserted hyphen in a simple WinAnsi face: code 0xAD, read back as U+00AD (rhud). */
const SHY = '\u00AD';
const isHyphen = (c: string) => c === '-' || c === SHY;

describe('ReplaceText reflow hyphenates like AddTextBlock (6y39)', () => {
  for (const align of ['left', 'justify'] as const) {
    it(`an edit on the first line re-wraps with hyphens (${align})`, () => {
      // Edit on line 0, so every line is re-wrapped and the unhyphenated
      // original's lines before the edit play no part.
      // A justified 200pt box spreads its gaps past two em, which reflow
      // refuses as foreign ink; and the paragraph's base gap is read off its
      // unstretched LAST line, so that line must hold two words or more (at
      // 300pt it is 'implementation' alone, and the base is a stretched gap).
      // 320pt satisfies both.
      // And, as u3l5.5's oracle records, a justified replacement's own spaces
      // keep the Tw in force where they are written, so there it has none.
      const width = align === 'justify' ? 320 : undefined;
      const R = align === 'justify' ? 'Documentationandanalysis' : 'Documentation and analysis';
      const doc = block(LONG, { align, width });
      doc.Pages[0].ReplaceText('Documentation', R, HY);
      const want = block(LONG.replace('Documentation', unit(R)),
        { align, hyphenate: true, width: align === 'justify' ? width : measured(block(LONG, { align })) });
      const got = origins(doc);
      expect(got.some(([c]) => c === SHY)).toBe(true);   // non-vacuous: a hyphen WAS drawn
      same(got, origins(want));
    });
  }
  it('hyphenate absent leaves the whole-word reflow', () => {
    const a = block(LONG), b = block(LONG);
    a.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow' });
    b.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow', hyphenate: false });
    expect(b.Pages[0].Contents).toEqual(a.Pages[0].Contents);
    expect(origins(a).some(([c]) => isHyphen(c))).toBe(false);
  });
  it('no language and no lang option: whole-word, silently', () => {
    const a = block(LONG), b = block(LONG);
    a.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow' });
    b.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow', hyphenate: {} });
    expect(b.Pages[0].Contents).toEqual(a.Pages[0].Contents);
  });
  it('takes the language from the catalog /Lang', () => {
    const doc = block(LONG);
    doc.Lang = 'en-US';
    doc.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', { adjust: 'reflow', hyphenate: {} });
    expect(origins(doc).some(([c]) => c === SHY)).toBe(true);
  });
  it('draws the hyphen in a fallback face when the font has none', () => {
    // Code 45 remapped to /bullet: the font draws no '-'.
    const lines = ['alpha beta gamma', 'internationalization', 'delta epsilon'];
    const s = `BT /F1 12 Tf 20 280 Td (${lines[0]}) Tj 0 -14 Td (${lines[1]}) Tj 0 -14 Td (${lines[2]}) Tj ET`;
    const doc = Document.Open(buildSimpleTextPdf(s, { differences: '45 /bullet' }));
    expect(() => doc.Pages[0].ReplaceText('beta', 'betabetabeta', HY)).not.toThrow();
    const noFace = origins(doc);
    expect(noFace.some(([c]) => isHyphen(c))).toBe(false);   // no face: point skipped
    const doc2 = Document.Open(buildSimpleTextPdf(s, { differences: '45 /bullet' }));
    doc2.Pages[0].ReplaceText('beta', 'betabetabeta', { ...HY, fallbackFonts: ['Times-Roman'] });
    expect(origins(doc2).some(([c]) => c === SHY)).toBe(true);
    expect(new TextDecoder('latin1').decode(doc2.Pages[0].Contents)).toMatch(/Tf[^]*\(\\255\) Tj[^]*\/F1 12 Tf/);
  });
  it('a font that draws its own hyphen is not switched, fallbacks or not', () => {
    const lines = ['alpha beta gamma', 'internationalization', 'delta epsilon'];
    const s = `BT /F1 12 Tf 20 280 Td (${lines[0]}) Tj 0 -14 Td (${lines[1]}) Tj 0 -14 Td (${lines[2]}) Tj ET`;
    const doc = Document.Open(buildSimpleTextPdf(s));
    doc.Pages[0].ReplaceText('beta', 'betabetabeta', { ...HY, fallbackFonts: ['Times-Roman'] });
    expect(origins(doc).some(([c]) => c === SHY)).toBe(true);
    const content = new TextDecoder('latin1').decode(doc.Pages[0].Contents);
    expect(content.match(/Tf/g)).toHaveLength(1);
  });
  // Review Focus 1: a word drawn by two chained show operators.
  it('splits a word drawn by two show operators', () => {
    const s = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (inter) Tj (nationalization) Tj 0 -14 Td (delta) Tj ET';
    const doc = Document.Open(buildSimpleTextPdf(s));
    // Shrinking line 0 leaves room for a head of the split word, which breaks
    // inside the SECOND operator (interna-tionalization).
    doc.Pages[0].ReplaceText('beta gamma', 'b', HY);
    const text = doc.Pages[0].GetText();
    expect(text).toMatch(/interna\u00AD\ntionalization/);
    // The hyphen sits where the pen left the 'a' before it, on that line.
    const all = pageLayout(doc, doc.Pages[0], {}).all;
    const h = all.findIndex((g) => g.text === SHY);
    expect(all[h - 1].text).toBe('a');
    expect(all[h].quad[0]).toBeCloseTo(all[h - 1].penEnd[0], 3);
    expect(all[h].quad[1]).toBeCloseTo(all[h - 1].quad[1], 3);
    expect(all[h + 1].quad[1]).toBeLessThan(all[h].quad[1] - 1);
    expect(text.replace(/\u00AD\n/g, '')).toContain('internationalization');
  });
  // Review Focus 4: two paragraphs, two languages.
  it('each tagged paragraph hyphenates by its own /Lang', () => {
    const DE = 'Die Qualifikation zur Weltmeisterschaft und die Gesellschaft der Donaudampfschiffe beschäftigen Kapitäne und Steuerleute';
    // The fixture discriminates only because the patterns disagree here.
    expect(hyphenator(resolveHyphenation({ lang: 'de' })).points('Gesellschaft')).toContain(6);
    expect(hyphenator(resolveHyphenation({ lang: 'en' })).points('Gesellschaft')).not.toContain(6);
    const run = (lang?: string) => {
      const d = Document.New();
      d.AddMarkdown(`${LONG}\n\n${DE}`, { tagged: true, format: PageFormat.custom(320, 600) });
      const doc = Document.Open(d.Save());
      const ps: StructElement[] = [];
      const walk = (e: StructElement): void => { if (e.StandardType === 'P') ps.push(e); e.Children.forEach(walk); };
      doc.GetStructTree()!.Children.forEach(walk);
      if (lang) ps[1].Lang = lang;   // the German paragraph, through its element
      doc.Lang = 'en-US';
      doc.ReplaceText(/und die/, 'und', { adjust: 'reflow', hyphenate: {} });
      return doc.Pages[0].GetText();
    };
    expect(run('de')).toContain('Gesell\u00AD\nschaft');
    expect(run()).not.toMatch(/Gesell[-\u00AD]/);   // the same paragraph, read as English
  });
});
