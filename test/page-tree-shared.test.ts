import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';

/** `1lr9`: a page tree is a DAG, not a tree, as far as Open is concerned. A
 *  node listed twice used to throw 'cycle in page tree' and the file could not
 *  be opened at all — recovery rebuilt the same tree and threw again. */

const SHARED_LEAF = () => buildRawPdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 /MediaBox [0 0 10 10] >>',
  '<< /Type /Page /Parent 2 0 R >>',
]);

describe('Open with a page listed twice (1lr9)', () => {
  it('opens, with two Page entries over one dictionary', () => {
    const d = Document.Open(SHARED_LEAF());
    expect(d.Pages.length).toBe(2);
    expect(d.Pages[0].Dict).toBe(d.Pages[1].Dict);
    expect(d.Pages.map((p) => p.Number)).toEqual([1, 2]);
    expect(d.recovery).toBeUndefined();
  });

  it('is reported by Validate() and split by Repair()', () => {
    const d = Document.Open(SHARED_LEAF());
    expect(d.Validate().Issues.map((i) => i.rule)).toEqual(['PageTreeShared']);
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageTreeShared']);
    expect(d.Pages[0].Dict).not.toBe(d.Pages[1].Dict);
    const re = Document.Open(d.Save());
    expect(re.Pages.length).toBe(2);
    expect(re.Pages[0].Dict).not.toBe(re.Pages[1].Dict);
    expect(re.Validate().Passed).toBe(true);
  });

  it('Save() without Repair() writes the sharing back as it was', () => {
    const re = Document.Open(Document.Open(SHARED_LEAF()).Save());
    expect(re.Pages.length).toBe(2);
    expect(re.Pages[0].Dict).toBe(re.Pages[1].Dict);
  });

  it('a shared INTERMEDIATE node yields its pages twice, in order', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 6 0 R 3 0 R] /Count 5 /MediaBox [0 0 10 10] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 3 0 R /Rotate 90 >>',
      '<< /Type /Page /Parent 3 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Rotate 180 >>',
    ]));
    expect(d.Pages.map((p) => p.Rotate)).toEqual([90, 0, 180, 90, 0]);
    expect(d.Validate().Issues.map((i) => i.rule)).toEqual(['PageTreeShared']);
  });
});

describe('Open with a genuine /Kids cycle (1lr9)', () => {
  it('skips the back edge and opens; Validate() reports it', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 10 10] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 2 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    expect(d.Pages.length).toBe(1);
    expect(d.Validate().Issues.map((i) => i.rule)).toEqual(['PageTreeShared']);
    d.Repair();
    expect(Document.Open(d.Save()).Validate().Passed).toBe(true);
  });

  it('a node that lists itself', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 2 0 R] /Count 1 /MediaBox [0 0 10 10] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    expect(d.Pages.length).toBe(1);
  });
});

describe('a fan-out page tree is bounded (1lr9)', () => {
  /** Node i lists node i+1 twice; the last lists one page. `levels` nodes
   *  reach 2^levels pages through 2^(levels+1)-1 visits. */
  const fanOut = (levels: number) => {
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>'];
    for (let i = 0; i < levels; i++) {
      const me = i + 2, kid = i + 3;
      objs.push(`<< /Type /Pages${i ? ` /Parent ${me - 1} 0 R` : ''} /Kids [${kid} 0 R ${kid} 0 R] /Count ${2 ** (levels - i)} /MediaBox [0 0 1 1] >>`);
    }
    objs.push(`<< /Type /Page /Parent ${levels + 1} 0 R >>`);
    return buildRawPdf(objs);
  };

  it('refuses one past maxObjects with ResourceLimitError naming the field', () => {
    // 4 levels: 1 + 2 + 4 + 8 intermediate visits + 16 leaves = 31.
    const limits = LoadLimits.defaults.with({ maxObjects: 30 });
    let caught: unknown;
    try { Document.Open(fanOut(4), { limits }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ResourceLimitError);
    expect(String(caught)).toContain('maxObjects');
  });

  it('opens at exactly the bound', () => {
    const limits = LoadLimits.defaults.with({ maxObjects: 31 });
    expect(Document.Open(fanOut(4), { limits }).Pages.length).toBe(16);
  });

  it('refuses a 2^40 bomb under the defaults, fast', () => {
    const t = Date.now();
    expect(() => Document.Open(fanOut(40))).toThrow(ResourceLimitError);
    expect(Date.now() - t).toBeLessThan(20_000);
  });
});
