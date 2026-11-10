import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFontReplacePdf, simpleFont } from './helpers/build-font-replace-pdf.js';

const TIMES = { Times: simpleFont('Times-Roman') };
const viaGs = (content = 'BT /GS0 gs 20 100 Td (Hi there) Tj ET'): Document => Document.Open(buildFontReplacePdf({
  fonts: TIMES, pages: [{ content, fonts: {}, gsFonts: { GS0: 'Times' } }],
}));
const viaTf = (): Document => Document.Open(buildFontReplacePdf({
  fonts: TIMES, pages: [{ content: 'BT /F1 24 Tf 20 100 Td (Hi there) Tj ET', fonts: { F1: 'Times' } }],
}));

describe('an ExtGState /Font sets the font, as a Tf does (32000-1 Table 58)', () => {
  it('is extracted', () => {
    expect(viaGs().Pages[0].GetText()).toBe('Hi there');
  });

  it('is drawn exactly as the same text set by Tf', () => {
    expect(Buffer.compare(viaGs().Pages[0].ToImage(), viaTf().Pages[0].ToImage())).toBe(0);
  });

  it('is scoped by q/Q like the rest of the graphics state', () => {
    const doc = viaGs('q /GS0 gs Q BT 20 100 Td (gone) Tj ET BT /GS0 gs 20 50 Td (kept) Tj ET');
    expect(doc.Pages[0].GetText()).toBe('kept');
  });

  it('lists the font in the inventory', () => {
    const doc = viaGs();
    const fonts = doc.Fonts;
    expect(fonts.map((f) => f.name)).toEqual(['Times-Roman']);
  });
});

describe('a font first set inside q … Q does not survive the Q (g0ky.5)', () => {
  it('a Tf inside q/Q leaves no font after it, in extraction as in rendering', () => {
    const doc = Document.Open(buildFontReplacePdf({
      fonts: TIMES, pages: [{ content: 'q BT /F1 24 Tf ET Q BT 20 100 Td (gone) Tj ET', fonts: { F1: 'Times' } }],
    }));
    expect(doc.Pages[0].GetText()).toBe('');
    const blank = Document.Open(buildFontReplacePdf({ fonts: TIMES, pages: [{ content: '', fonts: { F1: 'Times' } }] }));
    expect(Buffer.compare(doc.Pages[0].ToImage(), blank.Pages[0].ToImage())).toBe(0);
  });
});
