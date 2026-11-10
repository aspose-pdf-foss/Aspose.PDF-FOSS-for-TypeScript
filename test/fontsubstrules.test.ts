import { describe, it, expect } from 'vitest';
import { ruleMatches, std14Substitute, fontFamilyKeys } from '../src/fontsubstrules.js';

describe('font substitution rule matching (g0ky.6)', () => {
  it('matches the whole name and the family part, not a longer family', () => {
    expect(ruleMatches('Arial', 'Arial-BoldMT')).toBe(true);
    expect(ruleMatches('Arial', 'Arial,Bold')).toBe(true);
    expect(ruleMatches('arial bold mt', 'Arial-BoldMT')).toBe(true);
    expect(ruleMatches('Arial', 'ArialNarrow')).toBe(false);
    expect(ruleMatches('Arial-BoldMT', 'Arial-ItalicMT')).toBe(false);
  });

  it('keeps EmbedFonts\u0027 family split', () => {
    expect(fontFamilyKeys('Times New Roman,Bold')).toEqual(['timesnewroman']);
    expect(fontFamilyKeys('Arial-BoldMT')).toEqual(['arialboldmt', 'arial']);
  });

  it('picks the Standard-14 member for a family word and a style', () => {
    expect(std14Substitute('Times', { bold: true, italic: true })).toBe('Times-BoldItalic');
    expect(std14Substitute('helvetica', { bold: false, italic: true })).toBe('Helvetica-Oblique');
    expect(std14Substitute('Courier', { bold: false, italic: false })).toBe('Courier');
    expect(std14Substitute('Courier-Bold', { bold: false, italic: false })).toBe('Courier-Bold');
    expect(std14Substitute('Arial', { bold: false, italic: false })).toBeUndefined();
  });
});
