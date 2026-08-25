import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

const FIGURE_PAGE = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

describe('ToMarkdown — untagged', () => {
  it('emits an ATX heading and a paragraph, blank-line separated', () => {
    const md = Document.Open(buildUntaggedHtmlPdf()).ToMarkdown();
    expect(md).toBe('# Quarterly Report\n\nRevenue grew twelve percent this year.\n');
  });

  it('ends with exactly one newline', () => {
    const md = Document.Open(buildUntaggedHtmlPdf()).ToMarkdown();
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('emits a page image as an inline data URI', () => {
    const md = Document.Open(buildTextAndImagePage(FIGURE_PAGE)).ToMarkdown();
    expect(md).toMatch(/!\[\]\(data:image\/png;base64,/);
  });
});

describe('ToMarkdown — tagged', () => {
  it('drives headings from the structure tree', () => {
    const md = Document.Open(buildTaggedPdf()).ToMarkdown();
    expect(md).toContain('## ');                     // the RoleMap H2
    expect(md).toContain('Body paragraph actual');   // /ActualText won
  });

  it('flattens the Document and Sect wrappers rather than emitting a marker', () => {
    const md = Document.Open(buildMultiPageTaggedPdf()).ToMarkdown();
    expect(md).toContain('Page one body');
    expect(md).toContain('Page two body');
    expect(md).not.toContain('Sect');
    expect(md).not.toContain('<div>');
  });

  it('emits a figure with its /Alt', () => {
    const md = Document.Open(buildMultiPageTaggedPdf()).ToMarkdown();
    expect(md).toContain('![A figure]');
  });

  it('emits a table as a GFM pipe table', () => {
    const md = Document.Open(buildTaggedTablePdf()).ToMarkdown();
    expect(md).toContain('| --- |');
    expect(md.split('\n').filter((l) => l.startsWith('|')).length).toBeGreaterThan(2);
  });
});

describe('ToMarkdown — page filtering', () => {
  it('emits only the requested page', () => {
    const md = Document.Open(buildMultiPageTaggedPdf()).Pages[1].ToMarkdown();
    expect(md).toContain('Page two body');
    expect(md).not.toContain('Page one body');
  });
});

describe('ToMarkdown — tagged and untagged agree', () => {
  // One deliberately simple document: a heading and a paragraph, where the
  // font-size ranking and the structure tree have no room to disagree.
  //
  // The 160pt gap is load-bearing and was found the hard way. AutoTag ranks per
  // BLOCK while docmodel.ts ranks per LINE, so with the fixture's default 30pt
  // gap the two lines cluster into one block, AutoTag emits a single P over
  // both, and the heading is lost before this exporter ever sees it. That
  // disagreement is AutoTag's and predates this work — the shipped HTML export
  // shows it too. Separating the blocks takes it out of the picture so this
  // test measures what it claims to.
  it('produces the same Markdown either way', () => {
    const plain = Document.Open(buildUntaggedHtmlPdf(160)).ToMarkdown();

    const tagged = Document.Open(buildUntaggedHtmlPdf(160));
    tagged.AutoTag();
    const viaTree = Document.Open(tagged.Save()).ToMarkdown();

    expect(viaTree).toBe(plain);
    expect(plain).toContain('# Quarterly Report');   // the heading really is there
  });
});

describe('ToMarkdown — contract', () => {
  it('never throws on a document with no content', () => {
    const doc = Document.New();
    expect(() => doc.ToMarkdown()).not.toThrow();
    expect(doc.ToMarkdown()).toBe('');
  });
});

/** Markdown for a source rendered through our own authoring stack.
 *
 *  `gfm` is on because a task list is a GFM extension; without it `- [ ] todo`
 *  is an ordinary item whose text opens with a bracket. */
function via(src: string, opts?: { tagged: boolean }): string {
  const doc = Document.New();
  doc.AddMarkdown(src, { gfm: true, ...(opts?.tagged ? { tagged: true } : {}) });
  return Document.Open(doc.Save()).ToMarkdown();
}

describe('ToMarkdown — lists', () => {
  it('emits a tight bullet list', () => {
    expect(via('- alpha\n- beta\n', { tagged: true })).toBe('- alpha\n- beta\n');
  });

  it('emits an ordered list counting from its start', () => {
    expect(via('3. three\n4. four\n', { tagged: true })).toBe('3. three\n4. four\n');
  });

  it('indents a nested list inside its parent item', () => {
    expect(via('- outer\n  - inner\n', { tagged: true })).toBe('- outer\n  - inner\n');
  });

  it('emits task markers', () => {
    expect(via('- [ ] todo\n- [x] done\n', { tagged: true })).toBe('- [ ] todo\n- [x] done\n');
  });

  it('separates the items of a loose list with a blank line', () => {
    const md = via('- alpha\n\n  second paragraph\n\n- beta\n', { tagged: true });
    expect(md).toContain('- alpha\n\n  second paragraph\n\n- beta');
  });
});

describe('ToMarkdown — code blocks', () => {
  it('fences a code block and keeps its indentation', () => {
    expect(via('```\nif (x) {\n    return 1;\n}\n```\n', { tagged: true }))
      .toBe('```\nif (x) {\n    return 1;\n}\n```\n');
  });

  it('lengthens the fence past any backtick run inside', () => {
    expect(via('````\nsee ``` for fences\n````\n', { tagged: true }))
      .toBe('````\nsee ``` for fences\n````\n');
  });

  it('never escapes inside a fence', () => {
    expect(via('```\nconst a = b[0] * 2;\n```\n', { tagged: true }))
      .toContain('const a = b[0] * 2;');
  });
});

describe('ToMarkdown — quotes', () => {
  it('prefixes every line of a quote', () => {
    expect(via('> quoted text\n', { tagged: true })).toBe('> quoted text\n');
  });

  it('composes nesting into a double prefix', () => {
    expect(via('> > deeper\n', { tagged: true })).toBe('> > deeper\n');
  });
});
