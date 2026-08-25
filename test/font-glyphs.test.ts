import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { TextFont } from '../src/font.js';
import { inflateStream } from '../src/flate.js';
import { isDict } from '../src/types.js';
import { buildSimpleTextPdfWithWidths } from './helpers/build-text-pdf.js';

function fontOf(doc: Document): TextFont {
  const res = doc.Pages[0].Resources!;
  const fonts = doc.resolve(res.get('Font')) as Map<string, any>;
  const fd = doc.resolve(fonts.get('F1'));
  if (!isDict(fd)) throw new Error('no font');
  return new TextFont(fd, (o) => doc.resolve(o), (s) => inflateStream(s as any));
}

describe('TextFont.decodeGlyphs', () => {
  it('emits one record per code with byte spans and em widths', () => {
    // 'AB' = codes 65,66; widths give A=500, B=750 (firstChar 65).
    const doc = Document.Open(buildSimpleTextPdfWithWidths('BT (AB) Tj ET', 65, [500, 750]));
    const glyphs = fontOf(doc).decodeGlyphs(new TextEncoder().encode('AB'));
    expect(glyphs.map((g) => g.text)).toEqual(['A', 'B']);
    expect(glyphs.map((g) => g.byteStart)).toEqual([0, 1]);
    expect(glyphs.map((g) => g.byteLen)).toEqual([1, 1]);
    expect(glyphs.map((g) => g.width)).toEqual([0.5, 0.75]);
  });

  it('flags the space code as a word space', () => {
    const doc = Document.Open(buildSimpleTextPdfWithWidths('BT (A B) Tj ET', 32, []));
    const glyphs = fontOf(doc).decodeGlyphs(new TextEncoder().encode('A B'));
    expect(glyphs.map((g) => g.isWordSpace)).toEqual([false, true, false]);
  });
});
