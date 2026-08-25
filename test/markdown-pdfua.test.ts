import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

/** Every construct the renderer supports, in one document. */
const SRC = [
  '# Title',
  '',
  'A paragraph with **bold**, *italic* and `code`, plus a [link](https://example.com).',
  '',
  '- first item',
  '- second item',
  '',
  '1. ordered',
  '2. items',
  '',
  '- [x] done',
  '- [ ] todo',
  '',
  '> a block quote',
  '',
  '```',
  'code line',
  '```',
  '',
  '---',
  '',
  '| Name | Qty |',
  '| :--- | --: |',
  '| apples | 12 |',
].join('\n');

describe('a tagged Markdown document passes PDF/UA', () => {
  it('passes with lang and title supplied', () => {
    const doc = Document.New();
    doc.AddMarkdown(SRC, {
      format: PageFormat.A4, tagged: true, gfm: true,
      lang: 'en-US', title: 'Everything',
    });
    const report = doc.ValidatePdfUa();
    // Name what failed rather than just asserting a boolean.
    expect(report.Errors.map((e) => e.rule)).toEqual([]);
    expect(report.Issues.filter((i) => i.rule === 'UntaggedContent')).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('still passes after a save and reopen', () => {
    const doc = Document.New();
    doc.AddMarkdown(SRC, {
      format: PageFormat.A4, tagged: true, gfm: true,
      lang: 'en-US', title: 'Everything',
    });
    expect(Document.Open(doc.Save()).ValidatePdfUa().Passed).toBe(true);
  });

  it('reports what is missing when lang and title are omitted', () => {
    // The library never fabricates accessibility metadata; the caller supplies
    // it, and the validator says so plainly when they do not.
    const doc = Document.New();
    doc.AddMarkdown(SRC, { format: PageFormat.A4, tagged: true, gfm: true });
    const rules = new Set(doc.ValidatePdfUa().Errors.map((e) => e.rule));
    expect(rules).toContain('NaturalLanguage');
    expect(rules).toContain('DocumentTitle');
  });

  it('page.AddMarkdown is conformant under a caller-supplied structParent', () => {
    // page.AddMarkdown has no `lang` option by design: the caller owns the
    // element, and setting its Lang is the one-liner that replaces the option.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const sect = doc.CreateStructTree().Append('Sect');
    sect.Lang = 'en-US';
    page.AddMarkdown(SRC, [72, 72, 451, 698], { gfm: true, structParent: sect });
    doc.SetMetadata({ title: 'Everything' });
    doc.DisplayDocTitle = true;
    expect(doc.ValidatePdfUa().Errors.map((e) => e.rule)).toEqual([]);
  });
});
