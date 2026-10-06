import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { replaceText } from '../src/textedit.js';
import { parseContentStream } from '../src/content.js';
import { isString, type PdfObject } from '../src/types.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildToUnicodePdf, buildMixedType0Pdf, buildSimpleTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';

// Code 0xC8 is ONE glyph drawing two characters, `fi` — the shape a real
// ligature takes. (A `/Differences` `/fi` fixture would not do: this library's
// glyph-name table has no `fi`, so it decodes to nothing.)
const LIG_CMAP = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
  '8 beginbfchar <C8> <00660069> <6E> <006E> <65> <0065> <6F> <006F> <78> <0078> <61> <0061> <62> <0062> <20> <0020> endbfchar\n';
const ligDoc = (stream: string) => Document.Open(buildToUnicodePdf(stream, LIG_CMAP));
const textOf = (doc: Document) => doc.Pages[0].GetText();
const opsOf = (doc: Document) => parseContentStream(doc.Pages[0].Contents);
/** The bytes of every show string on the page, in stream order, as latin1. */
const shown = (doc: Document): string[] => opsOf(doc).flatMap((op) => {
  const strs = op.operator === 'TJ' ? (op.operands[0] as PdfObject[]) : op.operands;
  return strs.filter(isString).map((s) => String.fromCharCode(...s.bytes));
});

describe('replaceText inside a ligature', () => {
  it('keeps the ligature characters before the match', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <C86E65> Tj ET');   // "fine"
    expect(textOf(doc)).toBe('fine');
    expect(replaceText(doc, doc.Pages[0], 'ine', 'one')).toBe(1);
    expect(textOf(doc)).toBe('fone');
  });

  it('keeps the ligature characters after the match', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <C86E65> Tj ET');
    expect(replaceText(doc, doc.Pages[0], 'f', 'x')).toBe(1);
    expect(textOf(doc)).toBe('xine');
  });

  it('keeps residue on both sides of a match spanning two ligatures', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <6FC8C878> Tj ET');   // "ofifix"
    expect(textOf(doc)).toBe('ofifix');
    expect(replaceText(doc, doc.Pages[0], 'if', 'eee')).toBe(1);
    expect(textOf(doc)).toBe('ofeeeix');
  });

  it('merges two matches inside one ligature into one edit', () => {
    // 0xCA draws "ffi". Two matches AND a residue in one glyph: a fixture whose
    // matches cover the whole glyph (`/[fi]/` on `fi`) passes the old
    // per-glyph code by luck, two identical full-glyph edits splicing to `aa`.
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '3 beginbfchar <CA> <006600660069> <6E> <006E> <65> <0065> endbfchar\n';
    const doc = Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <CA6E65> Tj ET', cmap));
    expect(textOf(doc)).toBe('ffine');
    expect(replaceText(doc, doc.Pages[0], /f/, 'a')).toBe(2);
    expect(textOf(doc)).toBe('aaine');
  });

  it('replaces a ligature covered exactly, leaving its neighbours byte-identical', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <6FC878> Tj ET');     // "ofix"
    expect(replaceText(doc, doc.Pages[0], 'fi', 'ab')).toBe(1);
    expect(textOf(doc)).toBe('oabx');
    expect(shown(doc)).toEqual(['oabx']);
  });

  it('keeps a glyph tail that layout trimmed at the line end', () => {
    // 0xD0 draws "a " — its trailing space is trimmed from the line's text.
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '2 beginbfchar <D0> <00610020> <62> <0062> endbfchar\n';
    const doc = Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <62D0> Tj ET', cmap));
    expect(textOf(doc)).toBe('ba');
    expect(replaceText(doc, doc.Pages[0], 'a', 'b')).toBe(1);
    expect(shown(doc)).toEqual(['bb ']);
  });

  it('throws on an unencodable residue and leaves the document byte-identical', () => {
    // 0xC9 draws "ſt"; WinAnsi has no ſ (U+017F), so the residue cannot encode.
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '1 beginbfchar <C9> <017F0074> endbfchar\n';
    const doc = Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <C9> Tj ET', cmap));
    const before = doc.Save();
    expect(() => replaceText(doc, doc.Pages[0], 't', 'x')).toThrow(UnsupportedFeatureError);
    expect(() => replaceText(doc, doc.Pages[0], 't', 'x')).toThrow(/ſ/);
    expect(doc.Save()).toEqual(before);
  });

  it('never encodes a cleared glyph, so a match running into a Type0 font succeeds', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar <0003> <006C> <0004> <006F> endbfchar\n';
    const doc = Document.Open(buildMixedType0Pdf(
      'BT /F1 12 Tf 20 250 Td (Hel) Tj /F2 12 Tf <00030004> Tj ET', cmap));
    expect(textOf(doc)).toBe('Hello');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(textOf(doc)).toBe('Bye');
  });

  it('puts the replacement on the first real glyph when a match starts on an inserted space', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td (ab) Tj 40 0 Td (ab) Tj ET');
    expect(replaceText(doc, doc.Pages[0], ' ab', 'X')).toBe(1);
    expect(shown(doc)).toEqual(['ab', 'X']);
  });

  it('edits nothing for a match made only of spaces layout inserted', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td (ab) Tj 40 0 Td (ab) Tj ET');
    expect(textOf(doc)).toBe('ab ab');
    const before = doc.Pages[0].Contents;
    // Nothing was replaced, so nothing is counted (u3l5.7).
    expect(replaceText(doc, doc.Pages[0], ' ', 'X')).toBe(0);
    expect(doc.Pages[0].Contents).toEqual(before);
  });

  it('counts only the matches that edited something', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td (ab) Tj 40 0 Td (ab) Tj ET');
    expect(replaceText(doc, doc.Pages[0], / |a/, 'X')).toBe(2);
    expect(textOf(doc)).toBe('Xb Xb');
  });
});

/** Plain Helvetica WinAnsi: the kern and operator cases need no ligature. */
const plainDoc = (stream: string) => Document.Open(buildSimpleTextPdf(stream));
/** The first TJ's array on the page. */
const tjArray = (doc: Document): PdfObject[] =>
  opsOf(doc).find((op) => op.operator === 'TJ')!.operands[0] as PdfObject[];
const numbersIn = (arr: PdfObject[]) => arr.filter((x) => typeof x === 'number');

describe('replaceText kerns inside a match', () => {
  it('drops a kern between two matched elements', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td [(Hel) -50 (lo)] TJ ET');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'World')).toBe(1);
    expect(textOf(doc)).toBe('World');
    expect(numbersIn(tjArray(doc))).toEqual([]);
  });

  it('keeps a kern after the match', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td [(Hello) -50 (X)] TJ ET');
    replaceText(doc, doc.Pages[0], 'Hello', 'Bye');
    expect(numbersIn(tjArray(doc))).toEqual([-50]);
  });

  it('keeps kerns when an unmatched string sits between matched ones in stream order', () => {
    // Helvetica 12pt: (lo) at 20..29.336; -2000 moves Z to 53.336..60.668;
    // 4889 moves (Hel) back to 2.0..20.0. Reading order is "Hel"+"lo", then Z.
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td [(lo) -2000 (Z) 4889 (Hel)] TJ ET');
    expect(textOf(doc)).toBe('Hello Z');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(numbersIn(tjArray(doc))).toEqual([-2000, 4889]);
    expect(textOf(doc)).toContain('Z');
  });
});

describe('replaceText removes an emptied Tj', () => {
  it('removes a Tj whose whole string was cleared', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td (Hel) Tj (lo) Tj ET');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(opsOf(doc).filter((op) => op.operator === 'Tj')).toHaveLength(1);
    expect(textOf(doc)).toBe('Bye');
  });

  it('draws what follows an emptied Tj where the pen leaves the replacement', () => {
    // Helvetica 12pt: "Bye" advances (667 + 500 + 556) * 12 / 1000 = 20.676.
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td (Hel) Tj (lo) Tj (X) Tj ET');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(opsOf(doc).filter((op) => op.operator === 'Tj')).toHaveLength(2);
    expect(doc.Pages[0].Search('Bye')[0].quads[0][0]).toBeCloseTo(20, 3);
    expect(doc.Pages[0].Search('X')[0].quads[0][0]).toBeCloseTo(40.676, 3);
  });

  it('removes an emptied Tj even when it held the anchor', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td (Hello) Tj ET');
    replaceText(doc, doc.Pages[0], 'Hello', '');
    expect(opsOf(doc).map((op) => op.operator)).toEqual(['BT', 'Tf', 'Td', 'ET']);
  });

  it('keeps an emptied TJ and an emptied quote operator, which still move the pen', () => {
    const doc = plainDoc("BT /F1 12 Tf 14 TL 20 250 Td [(Hel) -50 (lo)] TJ (ab) ' ET");
    replaceText(doc, doc.Pages[0], 'Hello', '');
    replaceText(doc, doc.Pages[0], 'ab', '');
    const ops = opsOf(doc).map((op) => op.operator);
    expect(ops).toContain('TJ');
    expect(ops).toContain("'");
  });

  it('leaves a Tj that was already empty alone', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td () Tj (Hello) Tj ET');
    replaceText(doc, doc.Pages[0], 'Hello', 'Bye');
    expect(opsOf(doc).filter((op) => op.operator === 'Tj')).toHaveLength(2);
  });
});

describe('replaceText and glyphs that draw no text', () => {
  // Code 0x27 maps to NO text: an ornament, a ToUnicode gap. It never enters
  // the assembled text, so no match covers it by position.
  const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
    '8 beginbfchar <27> <> <48> <0048> <65> <0065> <6C> <006C> <6F> <006F> <61> <0061> <62> <0062> <63> <0063> endbfchar\n' +
    '1 beginbfchar <64> <0064> endbfchar\n';
  const doc = (hex: string) => Document.Open(buildToUnicodePdf(`BT /F1 12 Tf 20 250 Td <${hex}> Tj ET`, cmap));

  it('removes a text-less glyph lying inside a replaced word', () => {
    const d = doc('4865276C6C6F');   // H e <27> l l o
    expect(textOf(d)).toBe('Hello');
    expect(replaceText(d, d.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(shown(d)).toEqual(['Bye']);
  });

  it('keeps a text-less glyph lying between two separate matches', () => {
    const d = doc('6162276364');     // a b <27> c d
    expect(textOf(d)).toBe('abcd');
    expect(replaceText(d, d.Pages[0], /ab|cd/, 'X')).toBe(2);
    expect(shown(d)).toEqual(["X'X"]);
  });

  const tjDoc = (arr: string) => Document.Open(buildToUnicodePdf(`BT /F1 12 Tf 20 250 Td ${arr} TJ ET`, cmap));

  it('drops kerns around a string holding a text-less glyph the match swept in', () => {
    const d = tjDoc('[<48> -50 <65276C> -50 <6C6F>]');   // H | e <27> l | l o
    expect(textOf(d)).toBe('Hello');
    expect(replaceText(d, d.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(numbersIn(tjArray(d))).toEqual([]);
    expect(shown(d)).toEqual(['Bye', '', '']);
  });

  it('keeps kerns around a text-less glyph at a string edge, which still draws', () => {
    const d = tjDoc('[<48> -50 <2765> -50 <6C6C6F>]');   // H | <27> e | l l o
    expect(textOf(d)).toBe('Hello');
    expect(replaceText(d, d.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(numbersIn(tjArray(d))).toEqual([-50, -50]);
    expect(shown(d)).toEqual(['Bye', "'", '']);
  });
});

describe('replaceText in a Type0 font', () => {
  const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
    '2 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n';
  const type0 = () => Document.Open(buildType0Pdf('BT /F1 12 Tf 20 250 Td <00030004> Tj ET', cmap));

  it('deletes matched text with an empty replacement: whole codes need no encoding', () => {
    const doc = type0();
    expect(replaceText(doc, doc.Pages[0], 'Hi', '')).toBe(1);
    expect(textOf(doc)).toBe('');
  });

  it('still refuses a non-empty replacement, before anything changes', () => {
    const doc = type0();
    const before = doc.Save();
    expect(() => replaceText(doc, doc.Pages[0], 'Hi', 'Yo')).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });
});
