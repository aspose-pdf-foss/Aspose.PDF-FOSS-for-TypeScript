import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { parseContentStream } from '../src/content.js';
import { isArray, isString } from '../src/types.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document, page = 0): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[page], { glyph: (g) => out.push(g) });
  return out;
};
/** Every show string's bytes on the page, in order, as latin1. */
const shown = (doc: Document): string => parseContentStream(doc.Pages[0].Contents)
  .flatMap((o) => (o.operator === 'TJ' && isArray(o.operands[0]) ? o.operands[0] : o.operands))
  .filter(isString).map((s) => String.fromCharCode(...s.bytes)).join('|');

describe('RestyleText: colour, size, font (u3l5.6)', () => {
  const S = 'BT /F1 12 Tf 20 250 Td (alpha beta gamma) Tj ET';

  it('colours the match and leaves the text as it was', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    expect(doc.Pages[0].RestyleText('beta', { color: [1, 0, 0] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('alpha beta gamma');
    const red = glyphs(doc).filter((g) => g.color);
    expect(red.map((g) => g.text).join('')).toBe('beta');
    for (const g of red) expect(g.color).toEqual([255, 0, 0]);   // GlyphEvent.color is 0..255
  });

  it('writes the same glyph bytes when only the colour changes', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    doc.Pages[0].RestyleText('beta', { color: [1, 0, 0] });
    expect(shown(doc).split('|').join('')).toBe('alpha beta gamma');
  });

  it('resizes and refonts the match only', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    doc.Pages[0].RestyleText('beta', { fontSize: 24, font: 'Courier' });
    expect(doc.Pages[0].GetText()).toBe('alpha beta gamma');
    const b = glyphs(doc).find((g) => g.text === 'b')!, g0 = glyphs(doc).find((g) => g.text === 'g')!;
    expect(b.fontSize).toBeCloseTo(24, 6);
    expect(b.font.name).toContain('Courier');
    expect(g0.fontSize).toBeCloseTo(12, 6);
  });

  it('restyles a match across two operators where each part is', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (one two) Tj 0 -14 Td (three four) Tj ET'));
    const before = glyphs(doc).map((g) => [g.text, g.quad[0], g.quad[1]]);
    expect(doc.Pages[0].RestyleText(/two\sthree/, { color: [0, 0, 1] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('one two\nthree four');
    expect(glyphs(doc).map((g) => [g.text, g.quad[0], g.quad[1]])).toEqual(before);
    expect(glyphs(doc).filter((g) => g.color).map((g) => g.text).join('')).toBe('twothree');
  });

  it('validates the style and the options before anything changes', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    const p = doc.Pages[0];
    expect(() => p.RestyleText('beta', {})).toThrow(TypeError);
    expect(() => p.RestyleText('beta', { underline: false })).toThrow(/changes nothing/);
    expect(() => p.RestyleText('beta', null as never)).toThrow(TypeError);
    expect(() => p.RestyleText('beta', { color: [1, 0, 0] }, 5 as never)).toThrow(TypeError);
    expect(() => p.RestyleText('beta', { fontSize: -1 })).toThrow(/RestyleText: fontSize/);
    expect(() => p.RestyleText('beta', { underline: { thickness: -1 } })).toThrow(TypeError);
    expect(p.GetText()).toBe('alpha beta gamma');
  });

  it('doc.RestyleText refuses before changing any page', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock('beta is fine here', [72, 400, 300, 100], { fontSize: 12 });
    d.AddPage();
    // One line at the page foot: a 60pt "beta" pushes "gamma" below the page.
    d.Pages[1].AddTextBlock('beta gamma', [72, 0, 300, 20], { fontSize: 12 });
    const doc = Document.Open(d.Save());
    const before = doc.Save();
    expect(() => doc.RestyleText('beta', { fontSize: 60 }, { adjust: 'reflow' })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });
});

describe('a form drawn twice is edited once (u3l5.6)', () => {
  it('ReplaceText does not write the replacement twice', () => {
    const doc = Document.Open(buildFormTextPdf('q 1 0 0 1 0 150 cm /Fm0 Do Q q /Fm0 Do Q',
      'BT /F1 12 Tf 10 100 Td (alpha beta) Tj ET'));
    expect(doc.Pages[0].ReplaceText('beta', 'BETA')).toBe(2);
    expect(doc.Pages[0].GetText().split('\n')).toEqual(['alpha BETA', 'alpha BETA']);
  });
});
