import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict } from '../src/types.js';
import { buildRawPdf, buildNestedPageTreePdf } from './helpers/build-page-tree-pdf.js';

const reopen = (d: Document) => Document.Open(d.Save());
const boxes = (d: Document) => d.Pages.map((p) => p.MediaBox);

describe('page edits on a nested tree (dmin.4)', () => {
  it('RemovePage leaves a tree Validate passes and keeps the inherited box', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.RemovePage(3);
    expect(d.Validate().Issues).toEqual([]);
    const re = reopen(d);
    expect(re.Validate().Issues).toEqual([]);
    expect(boxes(re)).toEqual([[0, 0, 100, 100], [0, 0, 100, 100]]);
  });

  it('Reorder keeps the intermediate node\'s box (it used to reset /Parent first)', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.Reorder([3, 1, 2]);
    expect(boxes(d)).toEqual([[0, 0, 200, 200], [0, 0, 100, 100], [0, 0, 100, 100]]);
    const re = reopen(d);
    expect(re.Validate().Issues).toEqual([]);
    expect(boxes(re)).toEqual([[0, 0, 200, 200], [0, 0, 100, 100], [0, 0, 100, 100]]);
  });

  it('InsertPage leaves a tree Validate passes', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.InsertPage(1, PageFormat.A4);
    const re = reopen(d);
    expect(re.Validate().Issues).toEqual([]);
    expect(boxes(re).slice(1)).toEqual([[0, 0, 100, 100], [0, 0, 100, 100], [0, 0, 200, 200]]);
  });

  it('every page\'s /Parent is the root afterwards, and the intermediate node is gone', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.RemovePage(3);
    const re = reopen(d);
    const root = re.resolve(re.catalog().get('Pages'));
    for (const p of re.Pages) expect(re.resolve(p.Dict.get('Parent'))).toBe(root);
    // Node 3 was the only /Pages node besides the root.
    let pagesNodes = 0;
    for (const [, obj] of re.objectEntries()) {
      if (isDict(obj) && obj.get('Type') && (obj.get('Type') as { name?: string }).name === 'Pages') pagesNodes++;
    }
    expect(pagesNodes).toBe(1);
  });

  it('does not copy the ROOT\'s own values down — the page still inherits them', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 50 50] >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    d.RemovePage(2);
    expect(d.Pages[0].Dict.has('MediaBox')).toBe(false);
    expect(d.Pages[0].MediaBox).toEqual([0, 0, 50, 50]);
  });

  it('does not overwrite a value the page states itself', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 /MediaBox [0 0 100 100] /Rotate 90 >>',
      '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 7 7] >>',
    ]));
    d.InsertPage(2, PageFormat.A4);
    expect(d.Pages[0].MediaBox).toEqual([0, 0, 7, 7]);
    expect(d.Pages[0].Rotate).toBe(90);
  });
});
