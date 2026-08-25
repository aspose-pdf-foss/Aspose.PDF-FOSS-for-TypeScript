import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf, buildSimpleTextPdfWithWidths } from './helpers/build-text-pdf.js';

// A simple font may legally omit /Widths when it names one of the Standard 14
// faces (PDF 32000-1 9.6.2.2) — which is exactly what this library's own
// stamping layer writes. The interpreter behind GetTextFragments / ToImage /
// ToSvg must then measure with the Adobe AFM metrics, not a flat 0.5 em.
//
// Expected advances below are AFM sums, written out so the assertion does not
// run through the same table the code reads.

/** Advance width, in points, of the single fragment `stream` produces. */
function advance(pdf: Uint8Array): number {
  const frags = Document.Open(pdf).Pages[0].GetTextFragments();
  expect(frags).toHaveLength(1);
  const q = frags[0].quad;
  return q[2] - q[0];
}

const show = (text: string) => `BT /F1 9 Tf 20 250 Td (${text}) Tj ET`;

describe('Standard-14 metrics for a font with no /Widths', () => {
  it('measures Helvetica from its AFM widths, not a flat 500/1000', () => {
    // A l s o _ a v a i l a b l e
    // 667+222+500+556+278+556+500+556+222+222+556+556+222+556 = 6169
    expect(advance(buildSimpleTextPdf(show('Also available')))).toBeCloseTo(6169 / 1000 * 9, 5);
  });

  it('measures Times-Roman from its own table, not Helvetica\'s', () => {
    // 722+278+389+500+250+444+500+444+278+278+444+500+278+444 = 5749
    const pdf = buildSimpleTextPdf(show('Also available'), { baseFont: 'Times-Roman' });
    expect(advance(pdf)).toBeCloseTo(5749 / 1000 * 9, 5);
  });

  it('measures Courier as monospaced 600', () => {
    const pdf = buildSimpleTextPdf(show('Also available'), { baseFont: 'Courier' });
    expect(advance(pdf)).toBeCloseTo(14 * 600 / 1000 * 9, 5);
  });

  it('resolves the bold face through the /BaseFont name', () => {
    // Helvetica-Bold: A=722 l=278 s=556 o=611 space=278 a=556 v=556 a=556
    //                 i=278 l=278 a=556 b=611 l=278 e=556 = 6670
    const pdf = buildSimpleTextPdf(show('Also available'), { baseFont: 'Helvetica-Bold' });
    expect(advance(pdf)).toBeCloseTo(6670 / 1000 * 9, 5);
  });

  it('follows /Differences rather than the byte code', () => {
    // Code 65 is normally 'A' (667); remapped to 'bullet' it advances 350.
    const pdf = buildSimpleTextPdf(show('A'), { differences: '65 /bullet' });
    expect(advance(pdf)).toBeCloseTo(350 / 1000 * 9, 5);
  });

  it('follows a non-WinAnsi base encoding rather than the byte code', () => {
    // MacRoman 0xD5 is quoteright (222). The same byte in WinAnsi is Otilde (778).
    const pdf = buildSimpleTextPdf(show('\\325'), { encoding: 'MacRomanEncoding' });
    expect(advance(pdf)).toBeCloseTo(222 / 1000 * 9, 5);
  });

  it('uses the built-in encoding for Symbol', () => {
    // Symbol has no WinAnsi: code 0x61 is alpha (631), not 'a'.
    const pdf = buildSimpleTextPdf(show('a'), { baseFont: 'Symbol', encoding: null });
    expect(advance(pdf)).toBeCloseTo(631 / 1000 * 9, 5);
  });

  it('uses the built-in encoding for ZapfDingbats', () => {
    // ZapfDingbats code 0x34 is a check mark (a20), advance 846.
    const pdf = buildSimpleTextPdf(show('4'), { baseFont: 'ZapfDingbats', encoding: null });
    expect(advance(pdf)).toBeCloseTo(846 / 1000 * 9, 5);
  });

  it('measures stamped text back at the width the stamp was laid out with', () => {
    // The round trip the bug was found on: AddText writes a Standard-14 dict
    // with no /Widths, so reading it back must agree with MeasureText — a
    // fragment wider than the layout renders text overflowing a box it fits.
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.AddText('Also available', 50, 500, { font: 'Helvetica', fontSize: 9 });
    expect(page.MeasureText('Also available', 9, 'Helvetica')).toBeCloseTo(55.521, 3);
    expect(advance(doc.Save())).toBeCloseTo(55.521, 3);
  });

  it('still prefers an explicit /Widths array when the font carries one', () => {
    const pdf = buildSimpleTextPdfWithWidths(
      'BT /F1 9 Tf 20 250 Td (AB) Tj ET', 65, [1000, 1000],
    );
    expect(advance(pdf)).toBeCloseTo(2 * 9, 5);
  });
});
