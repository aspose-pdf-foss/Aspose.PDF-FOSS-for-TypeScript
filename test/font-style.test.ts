import { describe, it, expect } from 'vitest';
import { fontStyleOf } from '../src/font.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';

/** Identity resolve: these dicts hold no indirect references. */
const R = (o: PdfObject | undefined): PdfObject => o as PdfObject;

const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

const withDescriptor = (base: string, fd: [string, PdfObject][]): PdfDict =>
  dict([['BaseFont', name(base)], ['FontDescriptor', dict(fd)]]);

describe('fontStyleOf', () => {
  it('reads italic from /Flags bit 7', () => {
    expect(fontStyleOf(withDescriptor('AnonFace', [['Flags', 64]]), R))
      .toEqual({ bold: false, italic: true });
  });

  it('reads bold from the ForceBold flag', () => {
    expect(fontStyleOf(withDescriptor('AnonFace', [['Flags', 262144]]), R).bold).toBe(true);
  });

  it('reads italic from a non-zero /ItalicAngle', () => {
    expect(fontStyleOf(withDescriptor('AnonFace', [['ItalicAngle', -12]]), R).italic).toBe(true);
  });

  it('reads bold from /FontWeight >= 600', () => {
    expect(fontStyleOf(withDescriptor('AnonFace', [['FontWeight', 700]]), R).bold).toBe(true);
    expect(fontStyleOf(withDescriptor('AnonFace', [['FontWeight', 400]]), R).bold).toBe(false);
  });

  // A subset prefix must not defeat the name test: this is the everyday shape
  // of an embedded face, and an equality test against a face list misses it.
  it('sees through a subset prefix in the /BaseFont name', () => {
    expect(fontStyleOf(dict([['BaseFont', name('AAAAAB+Arial-BoldMT')]]), R).bold).toBe(true);
    expect(fontStyleOf(dict([['BaseFont', name('ABCDEF+Helvetica-Oblique')]]), R).italic).toBe(true);
  });

  it('treats a plain face as neither', () => {
    expect(fontStyleOf(dict([['BaseFont', name('Helvetica')]]), R))
      .toEqual({ bold: false, italic: false });
  });

  // The name is positive evidence in its own right. A descriptor that merely
  // omits /FontWeight says nothing, and must not veto a name that does.
  it('believes the name when the descriptor is silent', () => {
    expect(fontStyleOf(withDescriptor('Arial-BoldItalicMT', [['Flags', 4]]), R))
      .toEqual({ bold: true, italic: true });
  });

  // A composite font keeps its descriptor on the DESCENDANT, not the parent.
  it('finds a Type0 descriptor through /DescendantFonts', () => {
    const desc = dict([['FontDescriptor', dict([['Flags', 262144]])]]);
    const f = dict([
      ['Subtype', name('Type0')], ['BaseFont', name('AnonFace')],
      ['DescendantFonts', [desc] as unknown as PdfObject],
    ]);
    expect(fontStyleOf(f, R).bold).toBe(true);
  });
});
