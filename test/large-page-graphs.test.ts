import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { PdfArray, PdfDict } from '../src/types.js';
import { buildManyPagesPdf, buildWidePageGraphPdf } from './helpers/build-page-tree-pdf.js';

// Above V8's function-argument limit, below the default object/container bounds.
const COUNT = 150_000;

describe('large shallow page graphs (daqd)', () => {
  it.each(['Split', 'ExtractPages'] as const)('%s preserves a page referencing 150,000 independent objects', method => {
    const source = Document.Open(buildWidePageGraphPdf(COUNT));
    const output = method === 'Split'
      ? source.Split()[0]
      : source.ExtractPages([1]);
    expect(output.Pages).toHaveLength(1);
    const reopened = Document.Open(output.Save());
    const values = reopened.Pages[0].Dict.get('WideGraph') as PdfArray;
    expect(values).toHaveLength(COUNT);
    expect(values.every((value, i) => reopened.resolve(value) === i)).toBe(true);
    expect(source.isModifiedInternal()).toBe(false);
  }, 30_000);

  it('inserts 150,000 pages between existing pages without replacing the live page list', () => {
    const source = Document.Open(buildManyPagesPdf(COUNT));
    const target = Document.New(PageFormat.A4);
    target.Pages[0].Dict.set('Sequence', -1);
    target.AddPage().page.Dict.set('Sequence', -2);
    const livePages = target.Pages;
    const inserted = target.InsertPages(2, source);
    expect(inserted).toHaveLength(COUNT);
    expect(inserted[0]).toBe(2);
    expect(inserted[COUNT - 1]).toBe(150_001);
    expect(target.Pages).toBe(livePages);
    expect(target.Pages).toHaveLength(150_002);
    expect(target.Pages[0].Dict.get('Sequence')).toBe(-1);
    expect(target.Pages[1].Dict.get('Sequence')).toBe(0);
    expect(target.Pages[150_000].Dict.get('Sequence')).toBe(149_999);
    expect(target.Pages[150_001].Dict.get('Sequence')).toBe(-2);
    const reopened = Document.Open(target.Save());
    expect(reopened.Pages).toHaveLength(150_002);
    expect(reopened.Pages[0].Dict.get('Sequence')).toBe(-1);
    expect(reopened.Pages[1].Dict.get('Sequence')).toBe(0);
    expect(reopened.Pages[150_000].Dict.get('Sequence')).toBe(149_999);
    expect(reopened.Pages[150_001].Dict.get('Sequence')).toBe(-2);
    expect(source.Pages).toHaveLength(COUNT);
    expect(source.isModifiedInternal()).toBe(false);
  }, 30_000);

  it.each([false, true])('repairs a 150,000-page tree with a wrong count (null child: %s)', nullChild => {
    const doc = Document.Open(buildManyPagesPdf(COUNT, true, nullChild));
    const livePages = doc.Pages;
    expect(doc.Repair().map(issue => issue.rule)).toEqual(['PageCountMismatch']);
    expect(doc.Pages).toBe(livePages);
    expect(doc.Pages).toHaveLength(COUNT);
    expect(doc.Pages[149_999].Dict.get('Sequence')).toBe(149_999);
    const root = doc.resolve(doc.catalog().get('Pages')) as PdfDict;
    expect(root.get('Kids')).toHaveLength(COUNT);
    expect(doc.Validate().Passed).toBe(true);
  }, 30_000);
});
