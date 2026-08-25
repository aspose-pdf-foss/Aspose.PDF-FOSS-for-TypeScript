import { describe, it, expect } from 'vitest';
import { parseDA, resolveDA } from '../src/da.js';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { name, PdfObject } from '../src/types.js';

const str = (s: string) => ({ kind: 'string' as const, bytes: new TextEncoder().encode(s) });

describe('parseDA', () => {
  it('reads font, size and rgb', () => {
    expect(parseDA('/Helv 12 Tf 1 0 0 rg')).toEqual({
      fontName: 'Helv', size: 12, color: [1, 0, 0],
    });
  });
  it('reads gray', () => {
    expect(parseDA('/TiRo 0 Tf 0.25 g')).toEqual({
      fontName: 'TiRo', size: 0, color: [0.25, 0.25, 0.25],
    });
  });
  it('converts cmyk to rgb', () => {
    expect(parseDA('/Cour 8 Tf 0 0 0 1 k').color).toEqual([0, 0, 0]);
  });
  it('uses defaults for an empty/garbage string', () => {
    expect(parseDA('')).toEqual({ fontName: 'Helv', size: 0, color: [0, 0, 0] });
    expect(parseDA('garbage here')).toEqual({ fontName: 'Helv', size: 0, color: [0, 0, 0] });
  });
  it('keeps the last of repeated operators', () => {
    expect(parseDA('/Helv 6 Tf /Cour 10 Tf')).toMatchObject({ fontName: 'Cour', size: 10 });
  });
  // 'garbage here' above is well-formed garbage. An unmatched `>` is the
  // malformed kind, and it used to throw out of every appearance this /DA
  // styles rather than fall back to the defaults this function exists to give.
  it('ignores an unmatched > instead of throwing', () => {
    expect(parseDA('/Helv 12 Tf > 1 0 0 rg')).toEqual({
      fontName: 'Helv', size: 12, color: [1, 0, 0],
    });
  });
});

describe('resolveDA', () => {
  // resolveDA only needs a Document with a working resolve(); any opened doc works.
  const doc = Document.Open(buildFormPdf());

  it('prefers the field DA and maps DR font to a StdFont', () => {
    const fontDict = new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Times-Bold')],
    ]);
    const dr = new Map<string, PdfObject>([['Font', new Map([['F1', fontDict]])]]);
    const acro = new Map<string, PdfObject>([['DR', dr], ['DA', str('/Helv 10 Tf 0 g')]]);
    const field = new Map<string, PdfObject>([['DA', str('/F1 14 Tf 0 0 1 rg')]]);
    expect(resolveDA(doc, field, acro)).toMatchObject({
      fontName: 'F1', std: 'Times-Bold', size: 14, color: [0, 0, 1],
    });
  });

  it('falls back to AcroForm DA then default', () => {
    const acro = new Map<string, PdfObject>([['DA', str('/Cour 9 Tf 0.5 g')]]);
    expect(resolveDA(doc, new Map(), acro)).toMatchObject({ std: 'Courier', size: 9 });

    expect(resolveDA(doc, new Map(), new Map())).toMatchObject({
      std: 'Helvetica', size: 0, color: [0, 0, 0],
    });
  });
});
