import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { replaceText } from '../src/textedit.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildSimpleTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';

const open = (bytes: Uint8Array) => Document.Open(bytes);
const textOf = (doc: Document) => doc.Pages[0].GetText();
/** Replace, then round-trip through Save/Open and return the reloaded text. */
const roundTrip = (doc: Document): string => textOf(open(doc.Save()));

describe('replaceText (S2 constrained replace)', () => {
  it('replaces a whole show string in place', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello) Tj ET'));
    const n = replaceText(doc, doc.Pages[0], 'Hello', 'World');
    expect(n).toBe(1);
    expect(textOf(doc)).toBe('World');
    expect(roundTrip(doc)).toBe('World');
  });

  it('replaces a substring, preserving surrounding glyphs', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    expect(replaceText(doc, doc.Pages[0], 'World', 'Earth')).toBe(1);
    expect(textOf(doc)).toBe('Hello Earth');
  });

  it('replaces every occurrence', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (banana) Tj ET'));
    expect(replaceText(doc, doc.Pages[0], 'a', 'o')).toBe(3);
    expect(textOf(doc)).toBe('bonono');
  });

  it('accepts a RegExp', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (id 2026) Tj ET'));
    expect(replaceText(doc, doc.Pages[0], /\d{4}/, '0000')).toBe(1);
    expect(textOf(doc)).toBe('id 0000');
  });

  it('replaces a match spanning two TJ array elements', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td [(Hel)-50(lo)] TJ ET'));
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'World')).toBe(1);
    expect(textOf(doc)).toBe('World');
    expect(roundTrip(doc)).toBe('World');
  });

  it('removes the original text from the saved bytes', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (SECRET) Tj ET'));
    replaceText(doc, doc.Pages[0], 'SECRET', 'PUBLIC');
    const saved = new TextDecoder('latin1').decode(doc.Save());
    expect(saved).not.toContain('SECRET');
    expect(saved).toContain('PUBLIC');
  });

  it('returns 0 and edits nothing when there is no match', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello) Tj ET'));
    expect(replaceText(doc, doc.Pages[0], 'xyz', 'abc')).toBe(0);
    expect(textOf(doc)).toBe('Hello');
  });

  it('throws on a character not representable in the font encoding', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello) Tj ET'));
    expect(() => replaceText(doc, doc.Pages[0], 'Hello', '☃')).toThrow(UnsupportedFeatureError);
  });

  it('throws on a Type0 (Identity-H) font', () => {
    const cmap =
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n';
    const doc = open(buildType0Pdf('BT /F1 12 Tf 20 250 Td <00030004> Tj ET', cmap));
    expect(() => replaceText(doc, doc.Pages[0], 'Hi', 'Yo')).toThrow(UnsupportedFeatureError);
  });
});
