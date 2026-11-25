import { expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';

const pageWith = (ops: string) => Document.Open(buildSimpleTextPdf(
  `BT /F1 10 Tf ${ops} ET`, { baseFont: 'Courier' },
)).Pages[0];

it('offers independent drawing and reading order, with aligned report columns in grid mode', () => {
  const p = pageWith('1 0 0 1 80 80 Tm (22) Tj 1 0 0 1 20 80 Tm (BB) Tj ' +
    '1 0 0 1 20 96 Tm (A) Tj 1 0 0 1 80 96 Tm (1) Tj');
  expect(p.GetText()).toBe('A 1\nBB 22');
  expect(p.GetText({ mode: 'reading' })).toBe(p.GetText());
  expect(p.GetText({ mode: 'raw' })).toBe('22BB\nA 1');
  expect(p.GetText({ mode: 'grid' })).toBe('A         1\n\nBB        22');
});

for (const mode of ['reading', 'raw', 'grid'] as const) {
  it(`clips oriented glyph advances to both the rectangle and the rotated page CropBox in ${mode}`, () => {
    const p = pageWith('0 1 -1 0 40 20 Tm (ABCDE) Tj');
    p.Rotate = 90;
    p.CropBox = [30, 26, 65, 50];
    expect(p.GetText({ mode, limitToPageBounds: true })).toBe('BCDE');
    expect(p.GetText({ mode, rectangle: [35, 19, 45, 39], limitToPageBounds: true })).toBe('BC');
    expect(p.GetText({ mode, rectangle: [45, 39, 35, 26.001] })).toBe('BC');
    expect(p.GetText({ mode, rectangle: [50, 50, 90, 90] })).toBe('');
  });

  it(`keeps ActualText spans atomic when clipped in ${mode}`, () => {
    const p = pageWith('1 0 0 1 20 80 Tm /Span << /ActualText (office) >> BDC (XY) Tj EMC (!) Tj');
    expect(p.GetText({ mode, actualText: true })).toBe('office!');
    expect(p.GetText({ mode, actualText: true, rectangle: [26, 80, 50, 100] })).toBe('!');
  });
}

it('keeps whole replacement text including a literal trailing space', () => {
  const p = pageWith('/Span << /ActualText (end ) >> BDC (X) Tj EMC');
  for (const mode of ['raw', 'grid'] as const) expect(p.GetText({ mode, actualText: true })).toBe('end ');
});

it('places an overlapping grid fragment after the preceding word without interleaving their letters', () => {
  const p = pageWith('20 80 Td (ABC) Tj 1 0 0 1 23 80 Tm (XYZ) Tj');
  expect(p.GetText({ mode: 'grid' })).toBe('ABC XYZ');
  expect(p.GetText({ mode: 'raw' })).toBe('ABCXYZ');
});

it('uses the same layer visibility for alternate layouts and paragraph reads', () => {
  const p = Document.Open(buildOcgRenderPdf(
    '/OC /OCHid BDC /Span << /ActualText (label) >> BDC BT /F1 10 Tf (X) Tj ET EMC EMC',
  )).Pages[0];
  for (const mode of ['grid', 'raw'] as const) {
    expect(p.GetText({ mode, actualText: true })).toBe('');
    expect(p.GetText({ mode, actualText: true, includeHidden: true })).toBe('label');
  }
  expect(p.GetParagraphs()).toEqual([]);
  expect(p.GetParagraphs({ includeHidden: true }).map(part => part.text)).toEqual(['X']);
});
