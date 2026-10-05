import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { layoutLines } from '../src/text.js';
import { buildToUnicodePdf } from './helpers/build-text-pdf.js';

// Code 0x41 draws U+1D400 MATHEMATICAL BOLD CAPITAL A, two UTF-16 code units.
const CMAP = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
  '7 beginbfchar <41> <D835DC00> <48> <0048> <61> <0061> <65> <0065> <6C> <006C> <6F> <006F> <20> <0020> endbfchar\n';
const astralDoc = () => Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <4148656C6C6F> Tj ET', CMAP));

describe('layoutLines refs are per UTF-16 code unit', () => {
  it('gives an astral character one ref per code unit', () => {
    const { text, refs } = layoutLines([
      { x: 0, endX: 5, y: 0, text: '\u{1D400}', size: 10, ref: 1 },
      { x: 5, endX: 10, y: 0, text: 'b', size: 10, ref: 2 },
    ]);
    expect(text).toBe('\u{1D400}b');
    expect(refs).toEqual([1, 1, 2]);
  });

  it('Search hits the glyphs that drew a match after an astral character', () => {
    const doc = astralDoc();
    expect(doc.Pages[0].GetText()).toBe('\u{1D400}Hello');
    const [m] = doc.Pages[0].Search('Hello');
    expect(m.text).toBe('Hello');
    expect(m.hits.map((h) => h.text).join('')).toBe('Hello');
  });

  it('ReplaceText rewrites the right glyphs after an astral character', () => {
    const doc = astralDoc();
    expect(doc.Pages[0].ReplaceText('Hello', 'Hallo')).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('\u{1D400}Hallo');
  });
});
