import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isRef } from '../src/types.js';
import { buildRawPdf, buildNestedPageTreePdf } from './helpers/build-page-tree-pdf.js';

const rules = (d: Document) => d.Validate().Issues.map((i) => i.rule);

describe('doc.Validate() — clean documents', () => {
  it('passes a nested, sound page tree', () => {
    const r = Document.Open(buildNestedPageTreePdf()).Validate();
    expect(r.Issues).toEqual([]);
    expect(r.Passed).toBe(true);
  });

  it('passes a document authored in memory', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    d.AddPage(PageFormat.A4);
    expect(rules(d)).toEqual([]);
  });
});

describe('doc.Validate() — rules', () => {
  it('PageCountMismatch: /Count disagrees with the pages found', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 7 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const [issue] = d.Validate().Issues;
    expect(issue.rule).toBe('PageCountMismatch');
    expect(issue.severity).toBe('error');
    expect(issue.object?.num).toBe(2);
  });

  it('PageCountMismatch fires on an INTERMEDIATE node, not just the root', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 5 >>',
      '<< /Type /Page /Parent 3 0 R >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    const issues = d.Validate().Issues;
    expect(issues.map((i) => [i.rule, i.object?.num])).toEqual([['PageCountMismatch', 3]]);
  });

  it('PageParentMismatch: a kid whose /Parent is not the node listing it', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    const [issue, ...rest] = d.Validate().Issues;
    expect(rest).toEqual([]);
    expect(issue.rule).toBe('PageParentMismatch');
    expect(issue.object?.num).toBe(4);
    expect(issue.page).toBe(d.Pages[1]);
  });

  it('PageParentMismatch: a kid with no /Parent at all', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page >>',
    ]));
    expect(rules(d)).toEqual(['PageParentMismatch']);
  });

  it('PageMediaBoxMissing: no /MediaBox on the page or anywhere above it', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const issues = d.Validate().Issues;
    expect(issues.map((i) => [i.rule, i.object?.num])).toEqual([['PageMediaBoxMissing', 4]]);
    expect(issues[0].page).toBe(d.Pages[1]);
  });

  it('PageMediaBoxMissing: inherited from an intermediate node counts', () => {
    // buildNestedPageTreePdf: pages 4 and 5 own no box; node 3 carries one.
    expect(rules(Document.Open(buildNestedPageTreePdf()))).toEqual([]);
  });

  it('PageTreeShared: a page listed twice', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const issues = d.Validate().Issues;
    expect(issues.map((i) => [i.rule, i.object?.num])).toEqual([['PageTreeShared', 3]]);
  });

  it('PageTreeShared: a shared INTERMEDIATE node still counts toward its second parent', () => {
    // Node 3 holds two pages and is listed twice, so the root genuinely has
    // four pages under it. Only the sharing is wrong; /Count 4 is right, and
    // counting the second listing as one page would report a /Count
    // mismatch that is not there.
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 4 /MediaBox [0 0 1 1] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 3 0 R >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    expect(rules(d)).toEqual(['PageTreeShared']);
  });

  it('skips the /Parent check under an INLINE /Pages root, which no /Parent can name', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages << /Type /Pages /Kids [2 0 R] /Count 1 /MediaBox [0 0 1 1] >> >>',
      '<< /Type /Page >>',
    ]));
    expect(rules(d)).toEqual([]);
    expect(d.Repair()).toEqual([]);
    expect(d.Pages[0].Dict.has('Parent')).toBe(false);
  });

  it('PageTreeShared: a genuine /Kids cycle terminates and is reported', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 2 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    const issues = d.Validate().Issues;
    expect(issues.map((i) => [i.rule, i.object?.num])).toEqual([['PageTreeShared', 2]]);
  });

  it('CatalogInvalid: /Pages is not a /Type /Pages dictionary', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    d.catalog().set('Pages', { kind: 'ref', num: 3, gen: 0 });
    const r = d.Validate();
    expect(r.Issues.map((i) => i.rule)).toEqual(['CatalogInvalid']);
    expect(r.Passed).toBe(false);
  });
});

describe('doc.Validate() — deliberate non-rules', () => {
  it('a dangling reference is not a failure (7.3.10 makes it null)', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Outlines 99 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R /Annots [98 0 R] >>',
    ]));
    expect(rules(d)).toEqual([]);
  });

  it('a /Kids entry naming a missing object is null, and only the /Count sees it', () => {
    // /Count 1 agrees with the one real page: nothing to report.
    const ok = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    expect(rules(ok)).toEqual([]);
  });

  it('back-references are not cycles: /Parent, an annotation /P, outline /Prev', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>',
      '<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] /P 3 0 R >>',
      '<< /Type /Outlines /First 6 0 R /Last 7 0 R /Count 2 >>',
      '<< /Title (a) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit] >>',
      '<< /Title (b) /Parent 5 0 R /Prev 6 0 R /Dest [3 0 R /Fit] >>',
    ]));
    expect(rules(d)).toEqual([]);
  });

  it('reads the raw graph, not doc.Pages', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.Pages[0].Dict.delete('Parent');
    expect(rules(d)).toEqual(['PageParentMismatch']);
    expect(isRef(d.Validate().Issues[0].object)).toBe(true);
  });
});
