import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, type PdfArray } from '../src/types.js';
import { buildDefaultedPagePdf } from './helpers/build-page-tree-pdf.js';

const inherited = '/MediaBox [0 0 200 300] /CropBox [1 2 190 290] /Rotate 90 /Resources << /SourceOnly true >>';
const nulls = '/CropBox null /Rotate null /Resources null';
const sources = [
  { label: 'omitted optional attributes', attributes: {}, media: [0, 0, 200, 300] },
  { label: 'omitted MediaBox too', attributes: { root: '' }, media: [0, 0, 612, 792] },
  { label: 'indirect box coordinates', attributes: {
    root: '/MediaBox [0 0 5 0 R 6 0 R]', objects: ['200', '300'],
  }, media: [0, 0, 200, 300] },
  { label: 'null ancestor attributes', attributes: { root: inherited, ancestor: nulls }, media: [0, 0, 200, 300] },
  { label: 'null leaf attributes', attributes: { root: inherited, page: nulls }, media: [0, 0, 200, 300] },
  { label: 'malformed ancestor attributes', attributes: {
    root: inherited, ancestor: '/CropBox [0 0 1] /Rotate /Broken /Resources []',
  }, media: [0, 0, 200, 300] },
  { label: 'null MediaBox at an ancestor', attributes: {
    root: inherited, ancestor: `/MediaBox null ${nulls}`,
  }, media: [0, 0, 612, 792] },
  { label: 'dead attribute references', attributes: {
    root: inherited, page: '/MediaBox 99 0 R /CropBox 98 0 R /Rotate 97 0 R /Resources 96 0 R',
  }, media: [0, 0, 612, 792] },
];
const destination = () => Document.Open(buildDefaultedPagePdf({
  root: '/MediaBox [0 0 900 1000] /CropBox [0 0 50 50] /Rotate 180 /Resources << /DestinationOnly true >>',
}));

const operations = [
  { label: 'AddPage', run: (target: Document, source: Document) => target.AddPage(source.Pages[0]).number - 1 },
  { label: 'InsertPage', run: (target: Document, source: Document) => target.InsertPage(1, source.Pages[0]).number - 1 },
  { label: 'InsertPages', run: (target: Document, source: Document) => target.InsertPages(1, source)[0] - 1 },
  { label: 'Append', run: (target: Document, source: Document) => target.Append(source)[0] - 1 },
];

describe.each(operations)('$label preserves source defaults', ({ run }) => {
  it('retains explicit zero rotation, crop bounds and valid resources', () => {
    const source = Document.Open(buildDefaultedPagePdf({
      root: inherited,
      page: '/CropBox [5 10 180 280] /Rotate 0 /Resources << /SourceOnly true >>',
    }));
    const before = source.Save();
    const target = destination();
    const index = run(target, source);
    for (const doc of [target, Document.Open(target.Save())]) {
      const copied = doc.Pages[index];
      expect(copied.Rotate).toBe(0);
      expect(copied.CropBox).toEqual([5, 10, 180, 280]);
      expect(copied.Resources?.get('SourceOnly')).toBe(true);
      expect(copied.Resources?.has('DestinationOnly')).toBe(false);
    }
    expect(source.Save()).toEqual(before);
  });

  it.each(sources)('$label instead of inheriting destination settings', ({ attributes, media }) => {
    const source = Document.Open(buildDefaultedPagePdf(attributes));
    expect(source.Pages[0].MediaBox).toEqual(media);
    expect(source.Pages[0].CropBox).toEqual(media);
    expect(source.Pages[0].Rotate).toBe(0);
    expect(source.Pages[0].Resources).toBeUndefined();
    const before = source.Save();
    const target = destination();
    const index = run(target, source);

    for (const doc of [target, Document.Open(target.Save())]) {
      const copied = doc.Pages[index];
      expect(copied.MediaBox).toEqual(media);
      expect(copied.CropBox).toEqual(media);
      expect(copied.Rotate).toBe(0);
      const resources = copied.Resources;
      expect(isDict(resources)).toBe(true);
      expect(resources?.size).toBe(0);
      // Defaults must be stated as usable PDF values, not null/dead blockers.
      const rawMedia = doc.resolve(copied.Dict.get('MediaBox')) as PdfArray;
      const rawCrop = doc.resolve(copied.Dict.get('CropBox')) as PdfArray;
      expect(rawMedia.map(value => doc.resolve(value))).toEqual(media);
      expect(rawCrop.map(value => doc.resolve(value))).toEqual(media);
      expect(doc.resolve(copied.Dict.get('Rotate'))).toBe(0);

      const original = doc.Pages[index === 0 ? 1 : 0];
      expect(original.MediaBox).toEqual([0, 0, 900, 1000]);
      expect(original.CropBox).toEqual([0, 0, 50, 50]);
      expect(original.Rotate).toBe(180);
      expect(original.Resources?.get('DestinationOnly')).toBe(true);
    }
    expect(source.Save()).toEqual(before);
    expect(source.isModifiedInternal()).toBe(false);
  });
});
