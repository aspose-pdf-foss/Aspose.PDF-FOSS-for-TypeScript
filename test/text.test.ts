import { describe, it, expect } from 'vitest';
import { assembleLines, Run } from '../src/text.js';
import { Document } from '../src/document.js';
import {
  buildSimpleTextPdf, buildToUnicodePdf, buildType0Pdf, buildImageOnlyPdf,
  buildSimpleTextPdfWithWidths,
} from './helpers/build-text-pdf.js';

const run = (x: number, y: number, text: string, size = 10): Run =>
  ({ x, endX: x + text.length * size * 0.5, y, text, size });

describe('assembleLines', () => {
  it('returns empty string for no runs', () => {
    expect(assembleLines([])).toBe('');
  });
  it('orders runs left-to-right on one line', () => {
    expect(assembleLines([run(50, 100, 'World'), run(0, 100, 'Hello ')])).toBe('Hello World');
  });
  it('inserts a space across a wide x-gap', () => {
    // 'A' ends near x=5; 'B' starts at x=40 -> gap >> 0.25*size
    expect(assembleLines([run(0, 100, 'A'), run(40, 100, 'B')])).toBe('A B');
  });
  it('breaks lines on a y drop and orders top-to-bottom', () => {
    expect(assembleLines([run(0, 80, 'second'), run(0, 100, 'first')])).toBe('first\nsecond');
  });
});

const text = (bytes: Uint8Array) => Document.Open(bytes).Pages[0].GetText();

describe('Page.GetText integration', () => {
  it('extracts WinAnsi simple-font text', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET');
    expect(text(pdf)).toBe('Hello World');
  });

  it('infers spaces from TJ adjustments', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td [(Hello)-400(World)] TJ ET');
    expect(text(pdf)).toBe('Hello World');
  });

  it('joins two lines with a newline (Td line move)', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (first) Tj 0 -20 Td (second) Tj ET');
    expect(text(pdf)).toBe('first\nsecond');
  });

  it('decodes ToUnicode-mapped text', () => {
    // codes 0x01,0x02,0x03 -> H,i,! via ToUnicode
    const cmap =
      '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '3 beginbfchar <01> <0048> <02> <0069> <03> <0021> endbfchar\n';
    const pdf = buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <010203> Tj ET', cmap);
    expect(text(pdf)).toBe('Hi!');
  });

  it('decodes Type0 Identity-H text', () => {
    const cmap =
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n';
    const pdf = buildType0Pdf('BT /F1 12 Tf 20 250 Td <00030004> Tj ET', cmap);
    expect(text(pdf)).toBe('Hi');
  });

  it('extracts correctly under a cm transform', () => {
    const pdf = buildSimpleTextPdf('q 1 0 0 1 10 10 cm BT /F1 12 Tf 20 250 Td (Shifted) Tj ET Q');
    expect(text(pdf)).toBe('Shifted');
  });

  it('returns empty string for an image-only page', () => {
    expect(text(buildImageOnlyPdf())).toBe('');
  });
});

describe('Page.GetText real-width spacing', () => {
  it('does NOT insert a space when a wide glyph closes the gap', () => {
    // 'A' width 1000u @12pt = 12 units -> ends at x=32; 'B' starts at x=30
    // (inside the first glyph) -> gap = -2 -> no space -> "AB".
    // Old 0.5em estimate ends 'A' at x=26 -> gap 30-26=4 > 3 -> would insert a
    // space ("A B"), so this case fails before the refactor and passes after.
    const pdf = buildSimpleTextPdfWithWidths(
      'BT /F1 12 Tf 1 0 0 1 20 250 Tm (A) Tj 1 0 0 1 30 250 Tm (B) Tj ET',
      65, [1000, 1000], // A,B both 1000 glyph units
    );
    expect(Document.Open(pdf).Pages[0].GetText()).toBe('AB');
  });

  it('inserts a space when a narrow glyph leaves a gap', () => {
    // 'A' width 200u @12pt = 2.4 units -> ends at x=22.4; 'B' starts at x=26 ->
    // gap = 3.6 > 3 -> space -> "A B".
    // Old estimate ends 'A' at x=26 -> gap 0 -> no space ("AB"), so this case
    // also fails before the refactor and passes after.
    const pdf = buildSimpleTextPdfWithWidths(
      'BT /F1 12 Tf 1 0 0 1 20 250 Tm (A) Tj 1 0 0 1 26 250 Tm (B) Tj ET',
      65, [200, 200],
    );
    expect(Document.Open(pdf).Pages[0].GetText()).toBe('A B');
  });
});
