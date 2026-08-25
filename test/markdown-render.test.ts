import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { placeElements } from '../src/flowplace.js';

const SRC = [
  '# Title',
  '',
  'A paragraph with **bold**, *italic* and `code` in it, long enough to wrap',
  'across more than one line of a narrow column so pagination has work to do.',
  '',
  '- first item',
  '- second item',
  '',
  '> quoted',
  '',
  '```',
  'code line',
  '```',
  '',
  '---',
].join('\n');

describe('Flow.AddMarkdown', () => {
  it('renders a document and reports nothing skipped', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const res = flow.AddMarkdown(SRC);
    expect(res.skipped).toEqual([]);
    const pages = flow.Render();
    const text = pages[0].GetText();
    expect(text).toContain('Title');
    expect(text).toContain('first item');
    expect(text).toContain('quoted');
    expect(text).toContain('code line');
  });

  it('mixes with hand-built content in one flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddHeading(1, 'Hand built');
    flow.AddMarkdown('from markdown');
    flow.AddParagraph('hand built again');
    const text = flow.Render()[0].GetText();
    expect(text).toContain('Hand built');
    expect(text).toContain('from markdown');
    expect(text).toContain('hand built again');
  });

  it('renders a table rather than skipping it', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const res = flow.AddMarkdown('a\n\n| x | y |\n| - | - |\n| 1 | 2 |', { gfm: true });
    expect(res.skipped).toEqual([]);
    expect(flow.Render()[0].GetText()).toContain('x');
  });

  it('still reports a construct it cannot render', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const res = flow.AddMarkdown('a\n\n<div>raw</div>\n');
    expect(res.skipped).toEqual(['html_block']);
  });

  it('tags headings, paragraphs and lists under a tagged flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddMarkdown('# T\n\npara\n\n- a\n- b');
    flow.Render();
    // The tree is cyclic (kids link back to parents), so walk it rather than
    // serializing it.
    const types = new Set<string>();
    const walk = (el: import('../src/struct.js').StructElement): void => {
      types.add(el.Type);
      for (const kid of el.Children) walk(kid);
    };
    for (const kid of doc.GetStructTree()!.Children) walk(kid);
    for (const t of ['H1', 'P', 'L', 'LI', 'Lbl', 'LBody']) expect([...types]).toContain(t);
  });

  it('paginates across columns and pages', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2 });
    flow.AddMarkdown(`${SRC}\n\n${SRC}\n\n${SRC}\n\n${SRC}\n\n${SRC}`);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0].GetText().length).toBeGreaterThan(0);
  });
});

describe('Page.AddMarkdown', () => {
  it('lays markdown into a rect and reports what it used', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = page.AddMarkdown('# Title\n\nbody text', [50, 400, 300, 300]);
    expect(res.skipped).toEqual([]);
    expect(res.remainder).toEqual([]);
    expect(res.usedHeight).toBeGreaterThan(0);
    expect(page.GetText()).toContain('Title');
  });

  it('hands back a remainder that continues into another rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const first = page.AddMarkdown(SRC, [50, 700, 200, 60]);
    expect(first.remainder.length).toBeGreaterThan(0);
    const rest = placeElements(doc, page, first.remainder, [300, 100, 200, 600]);
    expect(rest.usedHeight).toBeGreaterThan(0);
  });

  it('validates its rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    expect(() => page.AddMarkdown('x', [0, 0, 0, 100])).toThrow(TypeError);
  });
});

describe('Document.AddMarkdown', () => {
  it('renders a whole document in one call', () => {
    const doc = Document.New();
    const res = doc.AddMarkdown(SRC, { format: PageFormat.A4, columns: 2 });
    expect(res.pages.length).toBeGreaterThanOrEqual(1);
    expect(res.skipped).toEqual([]);
    expect(res.pages[0].GetText()).toContain('Title');
  });
});

// The assertion that stops the rect placer and the column engine from drifting.
describe('the three entry points agree', () => {
  const textOf = (page: { GetText(): string }) => page.GetText().replace(/\s+/g, ' ').trim();

  it('produce the same text for the same source', () => {
    const viaFlow = (() => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      flow.AddMarkdown(SRC);
      return textOf(flow.Render()[0]);
    })();
    const viaDocument = (() => {
      const doc = Document.New();
      return textOf(doc.AddMarkdown(SRC, { format: PageFormat.A4 }).pages[0]);
    })();
    const viaPage = (() => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      // The same content box a default A4 flow uses: 72pt margins.
      page.AddMarkdown(SRC, [72, 72, 595.28 - 144, 841.89 - 144]);
      return textOf(page);
    })();
    expect(viaDocument).toBe(viaFlow);
    expect(viaPage).toBe(viaFlow);
  });
});

describe('public surface', () => {
  it('exports everything a caller needs from the package root', async () => {
    const api = await import('../src/index.js');
    for (const name of [
      'paragraph', 'heading', 'list', 'image', 'rule', 'codeBlock', 'quote',
      'placeElements', 'markdownElements', 'resolveMarkdownStyle',
      'table', 'createTable',
    ]) {
      expect(typeof (api as any)[name]).toBe('function');
    }
  });
});

describe('Document.AddMarkdown title', () => {
  it('sets /Info, XMP dc:title and DisplayDocTitle together', () => {
    const doc = Document.New();
    doc.AddMarkdown('# T\n\nbody', { format: PageFormat.A4, title: 'Quarterly Report' });
    expect(doc.GetMetadata().title).toBe('Quarterly Report');
    expect(doc.GetXmp().title).toBe('Quarterly Report');
    // A title without DisplayDocTitle satisfies neither PDF/UA nor the caller's
    // intent, so the two are set together or not at all.
    expect(doc.DisplayDocTitle).toBe(true);
  });

  it('touches neither when no title is given', () => {
    const doc = Document.New();
    doc.AddMarkdown('body', { format: PageFormat.A4 });
    expect(doc.GetMetadata().title).toBeUndefined();
    expect(doc.DisplayDocTitle).toBe(false);
  });

  it('rejects an empty title', () => {
    const doc = Document.New();
    expect(() => doc.AddMarkdown('body', { format: PageFormat.A4, title: '' }))
      .toThrow(TypeError);
  });

  it('rejects a non-string title before rendering anything', () => {
    const doc = Document.New();
    expect(() => doc.AddMarkdown('body', {
      format: PageFormat.A4, title: 7 as unknown as string,
    })).toThrow(TypeError);
    // Nothing was allocated: no page was appended.
    expect(doc.Pages.length).toBe(0);
  });
});
