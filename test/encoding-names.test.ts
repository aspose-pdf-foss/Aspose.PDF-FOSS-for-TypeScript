import { describe, it, expect } from 'vitest';
import {
  standardEncoding, macRoman, winAnsi, glyphToUnicode,
  standardEncodingNames, macRomanEncodingNames, winAnsiEncodingNames,
  baseEncodingNamesByName,
} from '../src/encoding.js';

/** The three encodings a PDF font may name, paired with the code->Unicode table
 *  encoding.ts already carried. The two were transcribed from the same Annex D
 *  rows independently, so each is a check on the other. */
const TABLES = [
  ['StandardEncoding', standardEncoding, standardEncodingNames],
  ['MacRomanEncoding', macRoman, macRomanEncodingNames],
  ['WinAnsiEncoding', winAnsi, winAnsiEncodingNames],
] as const;

/** Codes where a name and its Unicode legitimately disagree, because Annex D
 *  maps two codes onto one glyph. Not slack — an exhaustive list. */
const DUPLICATES: Record<string, number[]> = {
  StandardEncoding: [],
  MacRomanEncoding: [0xca],          // /space at the non-breaking-space code
  WinAnsiEncoding: [0xa0, 0xad],     // /space at nbsp, /hyphen at soft hyphen
};

/** Codes the Unicode table defines that Annex D Table D.2 does not name. */
const UNNAMED: Record<string, number[]> = {
  StandardEncoding: [],
  MacRomanEncoding: [0xb0],          // Apple's /infinity: MacRoman, but not PDF's
  WinAnsiEncoding: [0x7f],           // DEL, filled in by the 0x20..0xff loop
};

describe('Annex D glyph-name tables', () => {
  for (const [label, uni, names] of TABLES) {
    it(`${label}: every name agrees with the Unicode table at the same code`, () => {
      const bad: string[] = [];
      for (let c = 0; c < 256; c++) {
        const n = names[c];
        if (n === undefined || DUPLICATES[label].includes(c)) continue;
        const u = glyphToUnicode(n);
        if (u === undefined || uni[c] === undefined) continue;
        if (u !== uni[c]) bad.push(`0x${c.toString(16)} /${n} -> ${JSON.stringify(u)} != ${JSON.stringify(uni[c])}`);
      }
      expect(bad).toEqual([]);
    });

    it(`${label}: names every code the Unicode table defines`, () => {
      const missing: number[] = [];
      for (let c = 0; c < 256; c++) {
        if (uni[c] === undefined || UNNAMED[label].includes(c)) continue;
        if (names[c] === undefined) missing.push(c);
      }
      expect(missing).toEqual([]);
    });

    it(`${label}: names no code the Unicode table leaves empty`, () => {
      const extra: number[] = [];
      for (let c = 0; c < 256; c++) if (names[c] !== undefined && uni[c] === undefined) extra.push(c);
      expect(extra).toEqual([]);
    });
  }

  it('separates the three encodings where they actually differ', () => {
    expect(standardEncodingNames[0x27]).toBe('quoteright');
    expect(winAnsiEncodingNames[0x27]).toBe('quotesingle');
    expect(macRomanEncodingNames[0x27]).toBe('quotesingle');
    expect(standardEncodingNames[0x60]).toBe('quoteleft');
    expect(winAnsiEncodingNames[0x60]).toBe('grave');
    expect(standardEncodingNames[0xa9]).toBe('quotesingle');
    expect(winAnsiEncodingNames[0xa9]).toBe('copyright');
    expect(macRomanEncodingNames[0xa9]).toBe('copyright');
    expect(standardEncodingNames[0xe1]).toBe('AE');
    expect(winAnsiEncodingNames[0xe1]).toBe('aacute');
  });

  it('answers only for encodings a font may name', () => {
    expect(baseEncodingNamesByName('WinAnsiEncoding')).toBe(winAnsiEncodingNames);
    expect(baseEncodingNamesByName('MacRomanEncoding')).toBe(macRomanEncodingNames);
    expect(baseEncodingNamesByName('StandardEncoding')).toBe(standardEncodingNames);
    // No table, and no guess: MacExpert is a different character set entirely,
    // and PDFDoc is not a font encoding at all.
    expect(baseEncodingNamesByName('MacExpertEncoding')).toBeUndefined();
    expect(baseEncodingNamesByName('PDFDocEncoding')).toBeUndefined();
    expect(baseEncodingNamesByName(undefined)).toBeUndefined();
  });
});
