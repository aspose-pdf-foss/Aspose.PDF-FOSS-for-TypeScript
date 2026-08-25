import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildPageLabelsPdf } from './helpers/build-pagelabels-pdf.js';

const open = () => Document.Open(buildPageLabelsPdf());
const reopen = (d: Document) => Document.Open(d.Save());

describe('GetPageLabels (read)', () => {
  it('parses the number tree into ascending ranges', () => {
    expect(open().GetPageLabels()).toEqual([
      { startIndex: 0, style: 'roman' },
      { startIndex: 3, style: 'decimal', start: 1 },
      { startIndex: 5, style: 'decimal', prefix: 'A-' },
    ]);
  });

  it('returns [] for a document with no /PageLabels', () => {
    const doc = open();
    doc.catalog().delete('PageLabels');
    expect(doc.GetPageLabels()).toEqual([]);
  });
});

describe('PageLabelFor (resolution)', () => {
  it('resolves prefix + numeral across every range', () => {
    const doc = open();
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => doc.PageLabelFor(i)))
      .toEqual(['i', 'ii', 'iii', '1', '2', 'A-1', 'A-2']);
  });

  it('throws RangeError for an out-of-range page index', () => {
    const doc = open();
    expect(() => doc.PageLabelFor(-1)).toThrow(RangeError);
    expect(() => doc.PageLabelFor(7)).toThrow(RangeError);
    expect(() => doc.PageLabelFor(1.5)).toThrow(RangeError);
  });

  it('falls back to the decimal page number with no labels', () => {
    const doc = open();
    doc.catalog().delete('PageLabels');
    expect([0, 1, 6].map((i) => doc.PageLabelFor(i))).toEqual(['1', '2', '7']);
  });
});

describe('SetPageLabels (write + round-trip)', () => {
  it('round-trips a built number tree through Save()/Open()', () => {
    const doc = open();
    doc.SetPageLabels([
      { startIndex: 0, style: 'Roman' },
      { startIndex: 2, style: 'decimal', start: 5 },
      { startIndex: 4, style: 'alpha', prefix: 'App ' },
    ]);
    const got = reopen(doc).GetPageLabels();
    expect(got).toEqual([
      { startIndex: 0, style: 'Roman' },
      { startIndex: 2, style: 'decimal', start: 5 },
      { startIndex: 4, style: 'alpha', prefix: 'App ' },
    ]);
  });

  it('resolves the written labels after a round-trip', () => {
    const doc = open();
    doc.SetPageLabels([
      { startIndex: 0, style: 'Roman' },
      { startIndex: 2, style: 'decimal', start: 5 },
      { startIndex: 4, style: 'alpha', prefix: 'App ' },
    ]);
    const rt = reopen(doc);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => rt.PageLabelFor(i)))
      .toEqual(['I', 'II', '5', '6', 'App a', 'App b', 'App c']);
  });

  it('removes /PageLabels for an empty array', () => {
    const doc = open();
    doc.SetPageLabels([]);
    expect(doc.catalog().has('PageLabels')).toBe(false);
    expect(reopen(doc).GetPageLabels()).toEqual([]);
  });

  it('sorts ranges by startIndex before writing', () => {
    const doc = open();
    doc.SetPageLabels([
      { startIndex: 3, style: 'decimal' },
      { startIndex: 0, style: 'roman' },
    ]);
    expect(doc.GetPageLabels()).toEqual([
      { startIndex: 0, style: 'roman' },
      { startIndex: 3, style: 'decimal' },
    ]);
  });

  it('throws RangeError when the first range does not start at 0', () => {
    const doc = open();
    expect(() => doc.SetPageLabels([{ startIndex: 1, style: 'decimal' }])).toThrow(RangeError);
  });

  it('handles the none style as a bare prefix', () => {
    const doc = open();
    doc.SetPageLabels([{ startIndex: 0, style: 'none', prefix: 'cover' }]);
    expect(doc.PageLabelFor(0)).toBe('cover');
    expect(reopen(doc).GetPageLabels()).toEqual([{ startIndex: 0, style: 'none', prefix: 'cover' }]);
  });
});
