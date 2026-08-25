import { describe, it, expect } from 'vitest';
import { glyphToUnicode, winAnsi, standardEncoding, macRoman, pdfDocEncoding, encodeWinAnsi } from '../src/encoding.js';

describe('glyphToUnicode', () => {
  it('maps standard Latin glyph names', () => {
    expect(glyphToUnicode('A')).toBe('A');
    expect(glyphToUnicode('space')).toBe(' ');
    expect(glyphToUnicode('bullet')).toBe('•');
    expect(glyphToUnicode('adieresis')).toBe('ä');
    expect(glyphToUnicode('Euro')).toBe('€');
  });
  it('handles algorithmic uniXXXX / uXXXX names', () => {
    expect(glyphToUnicode('uni20AC')).toBe('€');
    expect(glyphToUnicode('u1F600')).toBe('\u{1F600}');
  });
  it('returns undefined for unknown names', () => {
    expect(glyphToUnicode('notdef')).toBeUndefined();
    expect(glyphToUnicode('totallybogus')).toBeUndefined();
  });
});

describe('base encodings', () => {
  it('WinAnsi: Latin-1 baseline + CP1252 overrides', () => {
    expect(winAnsi[0x41]).toBe('A');
    expect(winAnsi[0xe9]).toBe('é');      // é
    expect(winAnsi[0x80]).toBe('€');      // Euro
    expect(winAnsi[0x92]).toBe('’');      // right single quote
    expect(winAnsi[0x81]).toBeUndefined();     // unused slot
  });
  it('PDFDoc: shares the CP1252 block with WinAnsi', () => {
    expect(pdfDocEncoding[0x41]).toBe('A');
    expect(pdfDocEncoding[0xa0]).toBe('€'); // PDFDoc Euro at 0xA0
  });
  it('StandardEncoding: ASCII-ish with typographic quotes', () => {
    expect(standardEncoding[0x41]).toBe('A');
    expect(standardEncoding[0x27]).toBe('’'); // quoteright
    expect(standardEncoding[0x60]).toBe('‘'); // quoteleft
    // high range (Annex D Table D.2 STD column)
    expect(standardEncoding[0xb7]).toBe('•'); // bullet
    expect(standardEncoding[0xd0]).toBe('—'); // emdash
    expect(standardEncoding[0xe1]).toBe('Æ'); // AE
    expect(standardEncoding[0xe9]).toBe('Ø'); // Oslash
    expect(standardEncoding[0xfb]).toBe('ß'); // germandbls
    expect(standardEncoding[0xb0]).toBeUndefined(); // undefined slot stays undefined
  });
  it('MacRoman: ASCII baseline + high-range overrides', () => {
    expect(macRoman[0x41]).toBe('A');
    expect(macRoman[0x80]).toBe('Ä');     // Adieresis
    expect(macRoman[0xa5]).toBe('•');     // bullet
  });
});

describe('encodeWinAnsi', () => {
  it('encodes ASCII to identical byte codes', () => {
    expect(Array.from(encodeWinAnsi('Hi!'))).toEqual([0x48, 0x69, 0x21]);
  });

  it('maps CP1252 punctuation into the 0x80..0x9F block', () => {
    // U+2019 right single quote -> 0x92, U+2014 em dash -> 0x97
    expect(Array.from(encodeWinAnsi('’—'))).toEqual([0x92, 0x97]);
  });

  it('drops codepoints with no WinAnsi slot', () => {
    expect(Array.from(encodeWinAnsi('A\u{1F600}B'))).toEqual([0x41, 0x42]);
  });
});
