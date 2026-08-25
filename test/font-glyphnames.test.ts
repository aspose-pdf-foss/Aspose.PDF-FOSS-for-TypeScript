import { describe, it, expect } from 'vitest';
import { resolveSimpleEncoding, glyphNameResolver } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';

/** The identity resolver: these fixtures hold no indirect references. Mirrors
 *  `doc.resolve`, which answers null rather than undefined for an absent key. */
const R = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

describe('code -> glyph name precedence', () => {
  const builtin = new Map<number, string>([[0x41, 'Aprogram'], [0x42, 'Bprogram'], [0x43, 'Cprogram']]);

  it('prefers a /Differences name over everything', () => {
    const fd = dict([['Encoding', dict([
      ['BaseEncoding', name('WinAnsiEncoding')],
      ['Differences', [0x41, name('Adiff')]],
    ])]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(glyphNameResolver(enc, builtin)(0x41)).toBe('Adiff');
  });

  it('falls to the named base encoding before the program’s own', () => {
    const fd = dict([['Encoding', name('WinAnsiEncoding')]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(glyphNameResolver(enc, builtin)(0x42)).toBe('B');
    expect(glyphNameResolver(enc, builtin)(0xe9)).toBe('eacute');
  });

  it('uses the program’s own encoding when the font dict names none', () => {
    const enc = resolveSimpleEncoding(dict([]), R);
    expect(enc.implicit).toBe(true);
    expect(glyphNameResolver(enc, builtin)(0x43)).toBe('Cprogram');
  });

  it('falls to StandardEncoding when the program has no encoding either', () => {
    const enc = resolveSimpleEncoding(dict([]), R);
    expect(glyphNameResolver(enc, undefined)(0x41)).toBe('A');
    expect(glyphNameResolver(enc, undefined)(0x27)).toBe('quoteright');
  });

  it('does not invent a name for MacExpertEncoding', () => {
    // We have no MacExpert table. Falling through to the program is a real
    // answer; defaulting to WinAnsi's names would be a wrong one.
    const fd = dict([['Encoding', name('MacExpertEncoding')]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(enc.baseNames).toBeUndefined();
    expect(glyphNameResolver(enc, builtin)(0x41)).toBe('Aprogram');
  });

  it('reads /BaseEncoding from inside an /Encoding dict', () => {
    const fd = dict([['Encoding', dict([['BaseEncoding', name('MacRomanEncoding')]])]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(glyphNameResolver(enc, builtin)(0xd5)).toBe('quoteright');   // MacRoman
    expect(glyphNameResolver(enc, builtin)(0xa5)).toBe('bullet');
  });

  it('leaves unicode and names untouched', () => {
    const fd = dict([['Encoding', dict([['Differences', [0x41, name('uni25A1')]]])]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(enc.names[0x41]).toBe('uni25A1');
    expect(enc.unicode[0x41]).toBe('□');
  });
});
