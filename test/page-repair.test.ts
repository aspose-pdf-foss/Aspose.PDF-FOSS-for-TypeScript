import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isArray, isDict } from '../src/types.js';
import { buildRawPdf, buildNestedPageTreePdf } from './helpers/build-page-tree-pdf.js';
import { buildSigner } from './helpers/build-signer.js';

const rootOf = (d: Document) => {
  const r = d.resolve(d.catalog().get('Pages'));
  if (!isDict(r)) throw new Error('no root');
  return r;
};
const reopen = (d: Document) => Document.Open(d.Save());

describe('doc.Repair()', () => {
  it('returns [] and touches nothing on a sound document', () => {
    const base = buildNestedPageTreePdf();
    const d = Document.Open(base);
    const before = d.Save();
    expect(d.Repair()).toEqual([]);
    expect(d.Save()).toEqual(before);
  });

  it('does not mark a sound document modified (the sign path keeps its base)', async () => {
    // A full rewrite of an untouched model reproduces the same bytes, so a
    // save alone cannot see a spurious markModified(). Signing can: the
    // incremental append is taken only for an UNMODIFIED base.
    const d0 = Document.Open(buildNestedPageTreePdf());
    const base = d0.Save();
    const d = Document.Open(base);
    d.Repair();
    const s = buildSigner();
    await d.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(d.Save().subarray(0, base.length)).toEqual(base);
  });

  it('a salvaged /Count 7 over one page writes /Count 1 and drops the dead kid', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 7 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageCountMismatch']);
    const re = reopen(d);
    const root = rootOf(re);
    expect(root.get('Count')).toBe(1);
    const kids = re.resolve(root.get('Kids'));
    expect(isArray(kids) ? kids.length : -1).toBe(1);
    expect(re.Validate().Passed).toBe(true);
  });

  it('keeps a dead kid on a node whose /Count is already right', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    expect(d.Repair()).toEqual([]);
    const kids = d.resolve(rootOf(d).get('Kids'));
    expect(isArray(kids) ? kids.length : -1).toBe(2);
  });

  it('points a stale /Parent at the node listing it', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageParentMismatch']);
    expect(d.resolve(d.Pages[1].Dict.get('Parent'))).toBe(rootOf(d));
    expect(reopen(d).Validate().Passed).toBe(true);
  });

  it('writes US Letter onto a page with no /MediaBox anywhere', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const before = d.Pages[0].MediaBox;
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageMediaBoxMissing']);
    expect(d.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 612, 792]);
    // The written box is the one the library already reported.
    expect(d.Pages[0].MediaBox).toEqual(before);
  });

  it('copies a shared page so each listing owns its node', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageTreeShared']);
    expect(d.Pages.length).toBe(2);
    expect(d.Pages[0].Dict).not.toBe(d.Pages[1].Dict);
    expect(d.Validate().Passed).toBe(true);
    const re = reopen(d);
    expect(re.Pages.length).toBe(2);
    expect(re.Pages[0].Dict).not.toBe(re.Pages[1].Dict);
  });

  it('drops the back edge of a genuine /Kids cycle', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 2 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageTreeShared']);
    expect(d.Validate().Passed).toBe(true);
    expect(reopen(d).Pages.length).toBe(1);
  });

  it('refreshes doc.Pages onto the copy it made', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    d.Repair();
    const kids = d.resolve(rootOf(d).get('Kids'));
    if (!isArray(kids)) throw new Error('fixture');
    expect(d.Pages.map((p) => p.Dict)).toEqual(kids.map((k) => d.resolve(k)));
    expect(d.Pages[1].Dict).toBe(d.resolve(kids[1]));
  });

  it('does not repair CatalogInvalid (nothing to rebuild from)', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.catalog().set('Pages', { kind: 'ref', num: 4, gen: 0 });
    expect(d.Repair()).toEqual([]);
    expect(d.Validate().Issues.map((i) => i.rule)).toEqual(['CatalogInvalid']);
  });
});
