import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildSimpleTextPdf, buildMultiPageTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';

const open = (bytes: Uint8Array) => Document.Open(bytes);
const reopen = (doc: Document) => open(doc.Save());

describe('Page.ReplaceText', () => {
  it('replaces on the page and reports the count', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    const n = doc.Pages[0].ReplaceText('World', 'Earth');
    expect(n).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('Hello Earth');
  });

  it('extracts the replacement and drops the original after Save/Open', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (SECRET data) Tj ET'));
    doc.Pages[0].ReplaceText('SECRET', 'PUBLIC');
    const round = reopen(doc);
    expect(round.Pages[0].GetText()).toBe('PUBLIC data');
    expect(new TextDecoder('latin1').decode(doc.Save())).not.toContain('SECRET');
  });

  it('returns 0 when nothing matches', () => {
    const doc = open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello) Tj ET'));
    expect(doc.Pages[0].ReplaceText('xyz', 'abc')).toBe(0);
  });

  it('propagates UnsupportedFeatureError for a Type0 font', () => {
    const cmap =
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n';
    const doc = open(buildType0Pdf('BT /F1 12 Tf 20 250 Td <00030004> Tj ET', cmap));
    expect(() => doc.Pages[0].ReplaceText('Hi', 'Yo')).toThrow(UnsupportedFeatureError);
  });
});

describe('Document.ReplaceText', () => {
  it('replaces across every page and sums the count', () => {
    const doc = open(buildMultiPageTextPdf([
      'BT /F1 12 Tf 20 250 Td (foo and foo) Tj ET',
      'BT /F1 12 Tf 20 250 Td (more foo) Tj ET',
    ]));
    const n = doc.ReplaceText('foo', 'bar');
    expect(n).toBe(3);
    expect(doc.Pages[0].GetText()).toBe('bar and bar');
    expect(doc.Pages[1].GetText()).toBe('more bar');
  });

  it('round-trips a multi-page replacement through Save/Open', () => {
    const doc = open(buildMultiPageTextPdf([
      'BT /F1 12 Tf 20 250 Td (page one) Tj ET',
      'BT /F1 12 Tf 20 250 Td (page two) Tj ET',
    ]));
    doc.ReplaceText('page', 'leaf');
    const round = reopen(doc);
    expect(round.Pages[0].GetText()).toBe('leaf one');
    expect(round.Pages[1].GetText()).toBe('leaf two');
  });

  it('returns 0 when no page matches', () => {
    const doc = open(buildMultiPageTextPdf([
      'BT /F1 12 Tf 20 250 Td (alpha) Tj ET',
      'BT /F1 12 Tf 20 250 Td (beta) Tj ET',
    ]));
    expect(doc.ReplaceText('gamma', 'delta')).toBe(0);
  });
});
