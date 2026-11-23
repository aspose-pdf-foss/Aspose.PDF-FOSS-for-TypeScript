import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { streamOf } from '../src/pagecontent.js';
import { classifyShadowAppearance, compareShadowPages, findSignedRevision } from '../src/shadowanalysis.js';
import { isDict, isStream, name } from '../src/types.js';

function row(...samples: number[]) {
  return { width: samples.length, height: 1, rgb: Uint8Array.from(samples.flatMap((s) => [s, s, s])) };
}

describe('signed appearance classification', () => {
  it('accepts PDF whitespace at a complete revision boundary', () => {
    const bytes = new TextEncoder().encode('xref\n%%EOF\r\n \t');
    const revision = { xrefOffset: 0, length: 12 };
    expect(findSignedRevision([revision], bytes, 10)).toBe(revision);
    expect(findSignedRevision([revision], bytes, bytes.length)).toBe(revision);
  });

  it('rejects an incomplete revision or a signed extent between revisions', () => {
    const bytes = new TextEncoder().encode('xref\n%%EOF\nxref\n');
    const revisions = [{ xrefOffset: 0, length: 11 }, { xrefOffset: 11, length: bytes.length }];
    expect(findSignedRevision(revisions, bytes, 13)).toBeUndefined();
    expect(findSignedRevision(revisions, bytes, bytes.length)).toBeUndefined();
  });

  it('detects suppression of signed marks', () => {
    expect(classifyShadowAppearance(row(0, 255), row(255, 255)))
      .toEqual({ kind: 'hide', overlay: false });
  });

  it('detects substitution even when the marks occupy the same pixels', () => {
    expect(classifyShadowAppearance(row(0, 255), row(128, 255)))
      .toEqual({ kind: 'replace', overlay: false });
  });

  it('identifies an overlay when the signed marks survive underneath it', () => {
    const signed = row(0, 255);
    expect(classifyShadowAppearance(signed, row(255, 64), [signed]))
      .toEqual({ kind: 'hide-and-replace', overlay: true });
    expect(classifyShadowAppearance(signed, row(255, 255), [signed]))
      .toEqual({ kind: 'hide', overlay: true });
  });

  it('requires the underlying appearance to corroborate the signed mark', () => {
    expect(classifyShadowAppearance(row(0, 255), row(255, 0), [row(128, 255)]))
      .toEqual({ kind: 'replace', overlay: false });
  });

  it('keeps overlay suppression distinct from an independent new mark', () => {
    expect(classifyShadowAppearance(row(0, 255), row(255, 0), [row(0, 0)]))
      .toEqual({ kind: 'replace', overlay: true });
  });

  it('omits unchanged appearances and marks added in previously blank space', () => {
    expect(classifyShadowAppearance(row(0, 255), row(0, 0))).toBeUndefined();
    expect(classifyShadowAppearance(row(0, 255), row(0, 255))).toBeUndefined();
  });

  it('compares rendered pages in reading order and detects a removed page', () => {
    const signed = Document.Open(buildClassicPdf(2));
    const current = Document.Open(buildClassicPdf(1));
    current.Pages[0].Dict.set('Contents', current.allocObject(streamOf(new Uint8Array())));
    expect(compareShadowPages(signed, current)).toEqual({
      findings: [
        { page: 1, kind: 'hide', overlay: false },
        { page: 2, kind: 'hide', overlay: false },
      ],
      skippedPages: [],
    });
  });

  it('attributes a visible difference to a square annotation over an existing drawing', () => {
    const original = Document.Open(buildClassicPdf(1));
    original.Pages[0].Graphics().setFillColor([1, 0, 0]).drawRect(30, 30, 10, 10).fill().apply();
    const revised = Document.Open(original.Save());
    revised.Pages[0].AddSquare({ rect: [25, 25, 45, 45], fill: [0, 0, 1], width: 0 });
    expect(compareShadowPages(original, revised)).toEqual({
      findings: [{ page: 1, kind: 'hide-and-replace', overlay: true }],
      skippedPages: [],
    });
  });

  it('corroborates a difference caused by a later layer in a drawing', () => {
    const original = Document.Open(buildClassicPdf(1));
    original.Pages[0].Graphics().setFillColor([1, 0, 0]).drawRect(30, 30, 20, 10).fill().apply();
    const revised = Document.Open(original.Save());
    revised.Pages[0].Graphics().setFillColor([0, 0, 1]).drawRect(30, 30, 10, 10).fill().apply();
    expect(compareShadowPages(original, revised)).toEqual({
      findings: [{ page: 1, kind: 'hide-and-replace', overlay: true }],
      skippedPages: [],
    });
  });

  it('records pages with an unreadable viewport', () => {
    const original = Document.Open(buildClassicPdf(1));
    const revised = Document.Open(buildClassicPdf(1));
    revised.Pages[0].Dict.set('CropBox', [0, 0, 0, 100]);
    expect(compareShadowPages(original, revised)).toEqual({ findings: [], skippedPages: [1] });
  });

  it('records a page whose annotation appearance cannot be rendered', () => {
    const original = Document.Open(buildClassicPdf(1));
    const revised = Document.Open(buildClassicPdf(1));
    const square = revised.Pages[0].AddSquare({ rect: [25, 25, 45, 45] });
    const ap = revised.resolve(square.Dict.get('AP'));
    const stream = isDict(ap) ? revised.resolve(ap.get('N')) : undefined;
    if (!isStream(stream)) throw new Error('expected the square appearance');
    stream.dict.set('Filter', name('FlateDecode'));
    expect(compareShadowPages(original, revised)).toEqual({ findings: [], skippedPages: [1] });
  });
});
