import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { PdfDict, isDict, name, ref } from '../src/types.js';
import { buildType1, t1cs, t1num } from './helpers/build-type1.js';
import { buildType1Pdf, Type1PdfOptions } from './helpers/build-type1-pdf.js';

const NIMBUS = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.t1', import.meta.url)));
const PROGRAM_KEYS = ['FontFile', 'FontFile2', 'FontFile3'];

const pdfOf = (o: Partial<Type1PdfOptions>, program: Uint8Array = NIMBUS): Uint8Array =>
  buildType1Pdf(program, { text: 'AVA', size: 20, encoding: 'WinAnsiEncoding', baseFont: 'ABCDEF+Helvetica', ...o });

function fontAndDescriptor(doc: Document): { font: PdfDict; fd: PdfDict } {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
  const font = isDict(fonts) ? doc.resolve(fonts.get('F1')) : undefined;
  const fd = isDict(font) ? doc.resolve(font.get('FontDescriptor')) : undefined;
  if (!isDict(font) || !isDict(fd)) throw new Error('no font');
  return { font, fd };
}
const embedded = (doc: Document): boolean => PROGRAM_KEYS.some((k) => fontAndDescriptor(doc).fd.has(k));

describe('Optimize({ unembedStandard14 })', () => {
  it('is off by default', () => {
    const doc = Document.Open(pdfOf({}));
    const report = doc.Optimize();
    expect(report.unembedded).toEqual([]);
    expect(embedded(Document.Open(doc.Save()))).toBe(true);
  });

  it('removes the program and nothing else', () => {
    const pdf = pdfOf({});
    const orig = fontAndDescriptor(Document.Open(pdf));
    const doc = Document.Open(pdf);
    const report = doc.Optimize({ unembedStandard14: true });
    expect(report.unembedded).toEqual([{ baseFont: 'ABCDEF+Helvetica', bytesSaved: expect.any(Number) }]);
    expect(report.unembedded[0].bytesSaved).toBeGreaterThan(50_000);
    expect(report.unembedSkipped).toEqual([]);
    // Nothing reports the removed program as merely "not embedded".
    expect(report.skipped).toEqual([]);
    const saved = doc.Save();
    expect(saved.length).toBeLessThan(pdf.length - 50_000);
    const out = Document.Open(saved);
    const after = fontAndDescriptor(out);
    expect(embedded(out)).toBe(false);
    expect([...after.font.keys()].sort()).toEqual([...orig.font.keys()].sort());
    expect(out.resolve(after.font.get('Widths'))).toEqual(Document.Open(pdf).resolve(orig.font.get('Widths')));
    expect([...after.fd.keys()].sort()).toEqual([...orig.fd.keys()].filter((k) => k !== 'FontFile').sort());
    expect(out.Pages[0].GetText()).toBe(Document.Open(pdf).Pages[0].GetText());
  });

  it('leaves a custom face untouched and unreported', () => {
    const doc = Document.Open(pdfOf({ baseFont: 'ABCDEF+NimbusSans-Regular' }));
    const report = doc.Optimize({ unembedStandard14: true, fonts: false });
    expect(report.unembedded).toEqual([]);
    expect(report.unembedSkipped).toEqual([]);
    expect(embedded(doc)).toBe(true);
  });

  it('does not treat an alias like Arial as Standard-14', () => {
    const doc = Document.Open(pdfOf({ baseFont: 'Arial' }));
    expect(doc.Optimize({ unembedStandard14: true }).unembedded).toEqual([]);
  });

  it('unembeds with no /Encoding when the program itself uses StandardEncoding', () => {
    const doc = Document.Open(pdfOf({ encoding: undefined }));
    expect(doc.Optimize({ unembedStandard14: true }).unembedded).toHaveLength(1);
  });

  it('declines with no /Encoding when the program carries its own encoding', () => {
    const box = t1cs(t1num(0), t1num(500), 13, t1num(10), t1num(0), 21, t1num(100), 6, t1num(100), 7, 9, 14);
    const program = buildType1({ charstrings: { '.notdef': t1cs(t1num(0), t1num(500), 13, 14), A: box }, encoding: { 66: 'A' } });
    const doc = Document.Open(pdfOf({ encoding: undefined, text: 'B' }, program));
    const report = doc.Optimize({ unembedStandard14: true, fonts: false });
    expect(report.unembedded).toEqual([]);
    expect(report.unembedSkipped).toEqual([{
      baseFont: 'ABCDEF+Helvetica',
      reason: 'no /Encoding, and the embedded program\'s built-in encoding is not StandardEncoding',
    }]);
    expect(embedded(doc)).toBe(true);
  });

  it('declines a /Differences with no /BaseEncoding', () => {
    const doc = Document.Open(pdfOf({ encoding: undefined, differences: [[65, 'V']] }));
    const report = doc.Optimize({ unembedStandard14: true });
    expect(report.unembedSkipped[0].reason).toBe('/Differences has no /BaseEncoding, so it is relative to the embedded program');
  });

  it('accepts Latin /Differences names but declines one a built-in face may lack', () => {
    const ok = Document.Open(pdfOf({ differences: [[65, 'Aacute']] }));
    expect(ok.Optimize({ unembedStandard14: true }).unembedded).toHaveLength(1);
    const bad = Document.Open(pdfOf({ differences: [[65, 'g07']] }));
    const report = bad.Optimize({ unembedStandard14: true, fonts: false });
    expect(report.unembedSkipped[0].reason).toBe('/Differences names /g07, which a built-in Standard-14 face may not define');
    expect(embedded(bad)).toBe(true);
  });

  it('declines the symbolic faces', () => {
    const doc = Document.Open(pdfOf({ baseFont: 'Symbol' }));
    expect(doc.Optimize({ unembedStandard14: true }).unembedSkipped[0].reason)
      .toBe('Symbol is a symbolic face whose built-in encoding cannot be checked');
  });

  it('declines when a non-Standard-14 font shares the descriptor', () => {
    const doc = Document.Open(pdfOf({}));
    const fdRef = fontAndDescriptor(doc).font.get('FontDescriptor');
    doc.allocObject(new Map([
      ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Custom')], ['FontDescriptor', fdRef!],
    ]) as PdfDict);
    const report = doc.Optimize({ unembedStandard14: true, fonts: false });
    expect(report.unembedded).toEqual([]);
    expect(report.unembedSkipped[0].reason).toBe('its font descriptor is shared with a font that is not Standard-14');
    expect(embedded(doc)).toBe(true);
    void ref;
  });

  it('declines on a document that declares PDF/A, and ConvertToPdfA still converts after it', () => {
    // Unembed first: ConvertToPdfA embeds the bundled substitute (29z6.6) and
    // conforms. No /Widths, so the AFM widths it writes agree with the face —
    // the fixture's flat 1000s would not, and would rightly be declined.
    const doc = Document.Open(pdfOf({ omitWidths: true }));
    doc.Optimize({ unembedStandard14: true });
    expect(embedded(doc)).toBe(false);
    const conv = doc.ConvertToPdfA('2b');
    expect(embedded(doc)).toBe(true);
    expect(conv.passed).toBe(true);

    // And now the document claims PDF/A, so a second unembed is declined.
    const report = doc.Optimize({ unembedStandard14: true });
    expect(report.unembedded).toEqual([]);
    expect(report.unembedSkipped[0].reason).toBe('document declares PDF/A-2, which requires embedded fonts');
    expect(embedded(doc)).toBe(true);
  });
});
