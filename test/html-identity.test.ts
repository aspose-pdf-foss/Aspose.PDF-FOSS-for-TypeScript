import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';
import { buildTextAndImagePage, buildTwoImagePage } from './helpers/build-edit-pdf.js';

// A caption and a 1x1 image scaled to 100pt, for the /Figure path.
const FIGURE_PAGE = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

// A 2x2 ruled grid with cell text, as AutoTag's table detection sees it.
const RULED_TABLE = hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100)
  + vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200)
  + text(55, 175, 'A') + text(105, 175, 'B')
  + text(55, 125, 'C') + text(105, 125, 'D');

/** Re-save through AutoTag, the way the tagged fixtures in html.test.ts do. */
function autoTagged(src: Uint8Array, alt?: (e: { quad: number[] }) => string): Document {
  const doc = Document.Open(src);
  doc.AutoTag(alt ? { alt } : undefined);
  return Document.Open(doc.Save());
}

// This suite exists to freeze ToHtml's semantic output across the docmodel.ts
// refactor (no93.1). It asserts nothing about whether the markup is GOOD — only
// that it did not change. Never regenerate with `vitest -u`: the recorded
// snapshot is the only evidence the refactor preserved behaviour.
describe('ToHtml — semantic output is byte-identical', () => {
  it('untagged: headings, paragraphs', () => {
    expect(Document.Open(buildUntaggedHtmlPdf()).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('untagged: a ruled card beside a real grid', () => {
    const stream = hline(20, 120, 220) + hline(20, 120, 280)
      + vline(20, 220, 280) + vline(120, 220, 280)
      + text(30, 250, 'Card heading') + RULED_TABLE;
    expect(Document.Open(buildTablePdf(stream)).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('untagged: page images', () => {
    expect(Document.Open(buildTextAndImagePage(FIGURE_PAGE)).ToHtml({ fragment: true }))
      .toMatchSnapshot();
  });

  it('tagged: multi-page tree, whole document', () => {
    expect(Document.Open(buildMultiPageTaggedPdf()).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: multi-page tree, one page only', () => {
    expect(Document.Open(buildMultiPageTaggedPdf()).Pages[1].ToHtml({ fragment: true }))
      .toMatchSnapshot();
  });

  it('tagged: RoleMap, /Lang and /ActualText', () => {
    expect(Document.Open(buildTaggedPdf()).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: a table with a caption and header scope', () => {
    expect(Document.Open(buildTaggedTablePdf()).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: a Table element carrying no /Pg', () => {
    expect(autoTagged(buildTablePdf(RULED_TABLE)).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: a /Figure resolved to its image by MCID', () => {
    expect(autoTagged(buildTextAndImagePage(FIGURE_PAGE), () => 'a company logo')
      .ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: two figures on one page pair with their own images', () => {
    const src = buildTwoImagePage(
      'q 60 0 0 60 20 200 cm /Im0 Do Q q 60 0 0 60 20 100 cm /Im1 Do Q');
    expect(autoTagged(src, (e) => (e.quad[1] < 150 ? 'lower' : 'upper'))
      .ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('shell: doctype, title and CSS around a body', () => {
    expect(Document.Open(buildUntaggedHtmlPdf()).ToHtml()).toMatchSnapshot();
  });
});

/** A tagged document rendered from Markdown, for the constructs no93.2 adds.
 *
 *  `gfm` is on because a task list is a GFM extension. */
function fromMarkdown(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { tagged: true, gfm: true });
  return Document.Open(doc.Save());
}

describe('ToHtml — the constructs no93.2 adds', () => {
  it('tagged: a nested bullet list', () => {
    expect(fromMarkdown('- outer\n  - inner\n').ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: an ordered list with a start', () => {
    expect(fromMarkdown('3. three\n4. four\n').ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: a task list', () => {
    expect(fromMarkdown('- [ ] todo\n- [x] done\n').ToHtml({ fragment: true }))
      .toMatchSnapshot();
  });

  it('tagged: a code block and a quote', () => {
    expect(fromMarkdown('```\nx = 1;\n```\n\n> quoted\n').ToHtml({ fragment: true }))
      .toMatchSnapshot();
  });
});
