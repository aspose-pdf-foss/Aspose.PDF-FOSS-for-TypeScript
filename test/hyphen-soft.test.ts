// rhud: a hyphen hyphenation INSERTS is written as the face's soft-hyphen
// code where that draws the same glyph at the same width, so it reads back as
// U+00AD and a later reflow can tell it from an author's compound '-'.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildSimpleTextPdf, buildSimpleTextPdfWithWidths } from './helpers/build-text-pdf.js';

const T = 'Hyphenation keeps documentation of extraordinary responsibility readable in narrow columns';
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };
const latin1 = (d: Document) => new TextDecoder('latin1').decode(d.Pages[0].Contents);

describe('inserted hyphens are soft hyphens (rhud)', () => {
  it('AddTextBlock writes WinAnsi 0xAD, never a drawn -, at a break', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { fontSize: 12, hyphenate: { lang: 'en' } });
    const doc = Document.Open(d.Save());
    const s = latin1(doc);
    expect(s).toMatch(/\\255\) Tj/);
    expect(s).not.toMatch(/-\) Tj/);
    expect(doc.Pages[0].GetText()).toMatch(/[a-z]\u00AD\n/);
  });

  it('0xAD renders exactly as - in a WinAnsi Standard-14 face', () => {
    // Annex D: 0xAD is a second /hyphen. The render is the visual guarantee.
    const draw = (s: string) => Document.Open(buildSimpleTextPdf(`BT /F1 24 Tf 20 150 Td (in${s}) Tj ET`))
      .Pages[0].ToImage({ scale: 1 });
    expect(Buffer.compare(Buffer.from(draw('\\255')), Buffer.from(draw('-')))).toBe(0);
    // Non-vacuous: a different glyph renders differently.
    expect(Buffer.compare(Buffer.from(draw('\\267')), Buffer.from(draw('-')))).not.toBe(0);
  });

  it('an embedded face keeps the drawn -', () => {
    // One Identity-H glyph has one /ToUnicode meaning, so 0xAD is not available.
    const d = Document.New(PageFormat.A4);
    const font = d.AddFont(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf'));
    d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { font, fontSize: 12, hyphenate: { lang: 'en' } });
    const text = Document.Open(d.Save()).Pages[0].GetText();
    expect(text).toMatch(/[a-z]-\n/);
    expect(text).not.toContain('\u00AD');
  });

  // A reflow in the text's OWN simple font: 0xAD only where its advance is
  // the '-' code's. Widths from code 32; '-' is 45, 0xAD is 173.
  const widths = (soft: number) => Array.from({ length: 173 - 32 + 1 }, (_, i) => (i + 32 === 45 ? 333 : i + 32 === 173 ? soft : 556));
  const reflowIn = (soft: number) => {
    const s = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (internationalization) Tj 0 -14 Td (delta epsilon) Tj ET';
    const doc = Document.Open(buildSimpleTextPdfWithWidths(s, 32, widths(soft)));
    doc.Pages[0].ReplaceText('beta', 'betabetabeta', HY);
    return doc;
  };
  it('a reflow writes the soft-hyphen code of a font whose 0xAD is as wide as -', () => {
    const doc = reflowIn(333);
    expect(latin1(doc)).toMatch(/\\255\) Tj/);
    expect(doc.Pages[0].GetText()).toMatch(/\u00AD\n/);
  });
  it('a reflow keeps - in a font whose /Widths give 0xAD another advance', () => {
    const doc = reflowIn(0);
    expect(latin1(doc)).not.toContain('\\255');
    expect(doc.Pages[0].GetText()).toMatch(/-\n/);
  });
});
