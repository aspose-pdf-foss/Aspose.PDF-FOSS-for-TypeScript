import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

// A word gap made by a kern or a positioning operator, not a space glyph
// (567g). Helvetica 12pt: a quarter em is 3pt, "Hello" is 27.336pt wide.
const page = (s: string) => Document.Open(buildSimpleTextPdf(s)).Pages[0];
const fragText = (s: string) => page(s).GetTextFragments().map((f) => f.text);

describe('text fragments infer a word space from a gap (567g)', () => {
  it('reads a TJ word kern as a space, as GetText does', () => {
    const src = 'BT /F1 12 Tf 20 250 Td [(Hello) -400 (world)] TJ ET';   // 4.8pt gap
    expect(fragText(src)).toEqual(['Hello world']);
    expect(page(src).GetText()).toBe('Hello world');
  });

  it('keeps an ordinary kern inside a word', () => {
    const src = 'BT /F1 12 Tf 20 250 Td [(Wa) 80 (ter)] TJ ET';           // -0.96pt
    expect(fragText(src)).toEqual(['Water']);
    expect(page(src).GetText()).toBe('Water');
  });

  it('agrees with GetText exactly at the quarter-em boundary', () => {
    // -250 is exactly 3pt: not a word gap for either.
    const src = 'BT /F1 12 Tf 20 250 Td [(Hello) -250 (world)] TJ ET';
    expect(fragText(src)).toEqual(['Helloworld']);
    expect(page(src).GetText()).toBe('Helloworld');
  });

  it('never doubles a space the text already has', () => {
    expect(fragText('BT /F1 12 Tf 20 250 Td [(Hello ) -400 (world)] TJ ET')).toEqual(['Hello world']);
    expect(fragText('BT /F1 12 Tf 20 250 Td [(Hello) -400 ( world)] TJ ET')).toEqual(['Hello world']);
  });

  it('reads a gap between two positioned show operators', () => {
    // "Hello" ends at 47.336; "world" starts 4.664pt later.
    const src = 'BT /F1 12 Tf 20 250 Td (Hello) Tj ET BT /F1 12 Tf 52 250 Td (world) Tj ET';
    expect(fragText(src)).toEqual(['Hello world']);
  });

  it('carries the space into the structured text after a reflow', () => {
    // The issue's own reproduction: reflow moves "lazy" up beside "the" with a
    // kern, and the line read "thelazy".
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock('The quick brown fox jumps over the lazy dog and then keeps running far away into the woods',
      [72, 300, 200, 400], { fontSize: 12 });
    const doc = Document.Open(d.Save());
    doc.Pages[0].ReplaceText('quick', 'remarkably quick indeed', { adjust: 'reflow' });
    const lines = doc.Pages[0].GetStructuredText().flatMap((b) => b.lines.map((l) => l.text));
    // GetText trims each line's trailing whitespace; structured lines do not.
    expect(lines.map((l) => l.trimEnd()).join('\n')).toBe(doc.Pages[0].GetText());
    expect(lines.some((l) => /thelazy|faraway/.test(l))).toBe(false);
  });
});
