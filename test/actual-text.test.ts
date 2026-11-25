import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormTextPdf, buildSimpleTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';

const semantic = { actualText: true };
const pageWith = (ops: string) => Document.Open(buildSimpleTextPdf(
  `BT /F1 10 Tf 1 0 0 1 20 100 Tm ${ops} ET`,
)).Pages[0];

describe('opt-in marked-content ActualText', () => {
  it('emits the outer replacement once, pops it, and distinguishes identical adjacent spans', () => {
    const page = pageWith(`(a) Tj /Span << /ActualText (fi) >> BDC
      (X) Tj /Span << /ActualText (inner) >> BDC (Y) Tj EMC (Z) Tj EMC
      /Span << /ActualText (fi) >> BDC (W) Tj EMC
      /Span << /ActualText () >> BDC (Q) Tj EMC (b) Tj`);
    expect(page.GetText()).toBe('aXYZWQb');
    expect(page.GetText(semantic)).toBe('afifib');
    expect(page.Search('i', semantic).map(m => m.hits.map(g => g.text))).toEqual([['X', 'Y', 'Z'], ['W']]);
    expect(page.Search('XYZ')[0].quads).toEqual(page.Search('fi', semantic)[0].quads);
  });

  it('uses Form-local named properties and maps each invocation in page coordinates', () => {
    const page = Document.Open(buildFormTextPdf(
      'q 1 0 0 1 10 90 cm /Fm0 Do Q q 2 0 0 2 30 20 cm /Fm0 Do Q',
      '/Span /P BDC BT /F1 10 Tf (X) Tj ET EMC',
      { pageRes: '/Properties << /P << /ActualText (wrong) >> >>',
        formRes: '/Properties << /P 7 0 R >>', extra: ['<< /ActualText <FEFFD83DDE0000660069> >>'] },
    )).Pages[0];
    expect(page.GetText(semantic)).toBe('😀fi\n😀fi');
    const matches = page.Search(/fi/g, semantic);
    expect(matches.map(m => m.hits.map(g => g.text))).toEqual([['X'], ['X']]);
    expect(matches.map(m => m.quads[0].slice(0, 2))).toEqual([[10, 90], [30, 20]]);
    expect(page.Search('fi', { ...semantic, region: [25, 15, 50, 45] })).toHaveLength(1);
    expect(page.GetTextFragments().map(f => f.text)).toEqual(['X', 'X']);
  });

  it('maps either letter of a ligature to the single encoded glyph', () => {
    const page = Document.Open(buildSimpleTextPdf(
      'BT /F1 10 Tf /Span << /ActualText (fi) >> BDC (X) Tj EMC ET',
      { differences: '88 /fi' },
    )).Pages[0];
    expect(page.GetText()).toBe('ﬁ');
    const [match] = page.Search('i', semantic);
    expect(match.hits.map(g => [g.text, g.byteLen])).toEqual([['ﬁ', 1]]);
    expect(match.quads).toEqual(page.Search('ﬁ')[0].quads);
  });

  it('keeps the physical line break before an empty replacement at the next line start', () => {
    const page = pageWith('(A) Tj 12 TL T* /Span << /ActualText () >> BDC (X) Tj EMC (B) Tj');
    expect(page.GetText(semantic)).toBe('A\nB');
    expect(page.Search('A\nB', semantic)[0].quads).toHaveLength(2);
  });

  it('preserves blank physical lines outside replacements and returns no matches on an empty page', () => {
    const page = pageWith('12 TL ( ) Tj T* /Span << /ActualText (A) >> BDC (X) Tj EMC T* ( ) Tj T* (B) Tj T* ( ) Tj');
    expect(page.GetText(semantic)).toBe('\nA\n\nB\n');
    expect(pageWith('').Search(/^/, semantic)).toEqual([]);
  });

  it('reads a replacement even when its font has no Unicode mapping', () => {
    const page = Document.Open(buildType0Pdf(
      'BT /F1 10 Tf /Span << /ActualText (phone) >> BDC <0001> Tj EMC ET',
      '', { toUnicode: false },
    )).Pages[0];
    expect(page.GetText()).toBe('');
    expect(page.GetText(semantic)).toBe('phone');
    expect(page.Search('one', semantic)[0].hits.map(g => g.byteLen)).toEqual([2]);
  });

  it('honours optional-content visibility for replacement text and search hits', () => {
    const page = Document.Open(buildOcgRenderPdf(
      '/OC /OCHid BDC /Span << /ActualText (label) >> BDC BT /F1 10 Tf (X) Tj ET EMC EMC',
    )).Pages[0];
    expect(page.GetText(semantic)).toBe('');
    expect(page.Search('label', semantic)).toEqual([]);
    const all = { ...semantic, includeHidden: true };
    expect(page.GetText(all)).toBe('label');
    expect(page.Search('label', all)[0].hits.map(g => g.text)).toEqual(['X']);
  });

  it('inherits a caller span across a Form and retains every physical line for a partial match', () => {
    const page = Document.Open(buildFormTextPdf(
      '/Span << /ActualText (label) >> BDC /Fm0 Do EMC',
      'BT /F1 10 Tf 12 TL 20 80 Td (A) Tj T* (B) Tj ET',
    )).Pages[0];
    expect(page.GetText(semantic)).toBe('label');
    const [match] = page.Search('abe', semantic);
    expect(match.hits.map(g => g.text)).toEqual(['A', 'B']);
    expect(match.quads.map(q => q.slice(0, 2))).toEqual([[20, 80], [20, 68]]);
    expect(page.Search('label', { ...semantic, region: [15, 80, 40, 95] })).toEqual([]);
  });

  it('edits and redacts the painted glyphs independently of semantic search', () => {
    const page = pageWith('/Span << /ActualText (office) >> BDC (X) Tj EMC');
    expect(page.Search('office', semantic)).toHaveLength(1);
    expect(page.Search('office')).toEqual([]);
    expect(page.ReplaceText('office', 'A')).toBe(0);
    expect(page.RedactText('office')).toBe(0);
    expect(page.ReplaceText('X', 'Y')).toBe(1);
    expect(page.GetText()).toBe('Y');
    expect(page.RedactText('Y')).toBe(1);
    expect(page.GetText(semantic)).toBe('');
  });
});
