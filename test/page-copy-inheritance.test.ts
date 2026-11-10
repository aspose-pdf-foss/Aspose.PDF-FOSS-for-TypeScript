import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { type PdfDict, name } from '../src/types.js';
import { buildInheritedPageCopyPdf } from './helpers/build-page-tree-pdf.js';

const copies = [
  { label: 'Split', copy: (source: Document) => ({ doc: source.Split()[0], index: 0 }) },
  { label: 'AddPage', copy: (source: Document) => {
    const doc = Document.New(PageFormat.A4);
    doc.AddPage(source.Pages[0]);
    return { doc, index: 1 };
  } },
  { label: 'InsertPage', copy: (source: Document) => {
    const doc = Document.New(PageFormat.A4);
    doc.InsertPage(1, source.Pages[0]);
    return { doc, index: 0 };
  } },
  { label: 'ExtractPages', copy: (source: Document) => ({ doc: source.ExtractPages([1]), index: 0 }) },
];

describe.each(copies)('$label preserves page attributes', ({ copy }) => {
  it.each(['root', 'nested', 'page', 'mixed'] as const)('copies values from the %s levels and leaves the source unchanged', level => {
    const source = Document.Open(buildInheritedPageCopyPdf(level));
    const before = source.Save();
    const { doc, index } = copy(source);

    for (const output of [doc, Document.Open(doc.Save())]) {
      const page = output.Pages[index];
      expect(page.MediaBox).toEqual([10, 20, 310, 520]);
      expect(page.CropBox).toEqual([20, 30, 290, 490]);
      expect(page.Rotate).toBe(90);
      expect(page.GetText()).toBe('Inherited page');
      expect(page.Images).toHaveLength(1);
      expect(page.Images[0].Decode()).toEqual(Uint8Array.from([255, 0, 0]));
      const fonts = output.resolve(page.Resources!.get('Font')) as PdfDict;
      const font = output.resolve(fonts.get('F1')) as PdfDict;
      expect(font.get('BaseFont')).toEqual(name('Helvetica'));
    }

    // The output's inherited arrays and resource graph must be independent of
    // the source, including direct edits through live object-model handles.
    const copied = doc.Pages[index];
    const media = doc.resolve(copied.Dict.get('MediaBox')) as number[];
    media[2] = 999;
    const crop = doc.resolve(copied.Dict.get('CropBox')) as number[];
    crop[0] = 1000;
    const fonts = doc.resolve(copied.Resources!.get('Font')) as PdfDict;
    const font = doc.resolve(fonts.get('F1')) as PdfDict;
    font.set('BaseFont', name('Courier'));
    expect(source.Pages[0].MediaBox).toEqual([10, 20, 310, 520]);
    expect(source.isModifiedInternal()).toBe(false);
    expect(source.Save()).toEqual(before);
  });
});
