import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseHtml } from '../src/htmltree.js';
import { describe as describeReport } from '../src/htmlreport.js';
import type { NotRendered } from '../src/htmlreport.js';

/** The report as the flat strings, which is what most assertions want. */
const names = (skipped: NotRendered[]): string[] => skipped.map(describeReport);

const SRC = `<!doctype html>
<title>Doc Title</title>
<h1>Heading</h1>
<p>A paragraph of body text.</p>
<ul><li>alpha</li><li>bravo</li></ul>
<h2>Second</h2>
<p>More body text here.</p>`;
const textOf = (page: { GetText(): string }): string =>
  page.GetText().replace(/\s+/g, ' ').trim();
describe('the three entry points agree', () => {
  it('produce the same text for the same source', () => {
    const viaFlow = (() => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      flow.AddHtml(SRC);
      return textOf(flow.Render()[0]);
    })();
    const viaDocument = (() => {
      const doc = Document.New();
      return textOf(doc.AddHtml(SRC, { format: PageFormat.A4 }).pages[0]);
    })();
    const viaPage = (() => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      // The same content box a default A4 flow uses: 72pt margins.
      page.AddHtml(SRC, [72, 72, 595.28 - 144, 841.89 - 144]);
      return textOf(page);
    })();
    expect(viaDocument).toBe(viaFlow);
    expect(viaPage).toBe(viaFlow);
  });
});
describe('flow.AddHtml', () => {
  it('returns a report rather than `this`', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const res = flow.AddHtml('<p>a</p><div style="float:left;width:50px">s</div><div style="float:left;width:50px">t</div>');
    expect(names(res.skipped)).toContain('float:left');
    expect(Array.isArray(res.unsupported)).toBe(true);
  });
  it("uses the flow's COLUMN width, not the page width", () => {
    // A two-column flow must wrap where a one-column flow does not.
    const long = `<p>${'word '.repeat(60)}</p>`;
    const count = (columns: number): number => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4, columns });
      flow.AddHtml(long);
      return flow.Render()[0].GetTextFragments().length;
    };
    expect(count(2)).toBeGreaterThan(count(1));
  });
  it("resolves a percentage against the COLUMN width, not the column HEIGHT", () => {
    // The companion to the case above, and the only one of the two that can
    // see the BUILD width: BoxElement derives its inner width from the
    // placement context, so wrapping is placement-driven and stays correct
    // even when the wrong number is handed to the mapper. A percentage
    // margin is resolved at build time and cannot.
    const indent = (columns: number): number => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4, columns });
      flow.AddHtml('<p style="margin:0 0 0 25%">x</p>');
      return flow.Render()[0].GetTextFragments()[0].quad[0];
    };
    // A two-column flow's columns are half as wide, so its 25% is smaller.
    // Both flows share one column HEIGHT, so substituting that collapses the
    // difference to the 0 a column-x offset cannot produce.
    expect(indent(1)).toBeGreaterThan(0);
    expect(indent(2)).toBeLessThan(indent(1));
  });
  it('mixes with hand-built flow content', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('before');
    flow.AddHtml('<p>middle</p>');
    flow.AddParagraph('after');
    const t = textOf(flow.Render()[0]);
    expect(t.indexOf('before')).toBeLessThan(t.indexOf('middle'));
    expect(t.indexOf('middle')).toBeLessThan(t.indexOf('after'));
  });
});
describe('page.AddHtml', () => {
  it('reports usedHeight and an empty remainder when everything fits', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = page.AddHtml('<p>short</p>', [72, 72, 400, 600]);
    expect(res.usedHeight).toBeGreaterThan(0);
    expect(res.remainder).toEqual([]);
  });
  it('hands back a remainder that did not fit', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const long = `<p>${'word '.repeat(400)}</p>`;
    const res = page.AddHtml(long, [72, 72, 400, 60]);
    expect(res.remainder.length).toBeGreaterThan(0);
  });
  it('uses rect[2] as the BUILD width, not rect[3]', () => {
    // Measured with a PERCENTAGE margin, and it has to be: BoxElement derives
    // its inner width from the PLACEMENT context, so text wrapping is
    // placement-driven and cannot see the build width at all. A wrapping
    // fixture here passes with rect[3] substituted — verified by mutation.
    // A percentage resolves against the build width, so it can.
    const indent = (w: number, h: number): number => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      page.AddHtml('<p style="margin:0 0 0 25%">x</p>', [40, 40, w, h]);
      return page.GetTextFragments()[0].quad[0];
    };
    // Same height, different widths: the indent must follow the WIDTH.
    expect(indent(200, 600)).not.toBeCloseTo(indent(400, 600), 1);
    // And a wider rect gives a wider 25%.
    expect(indent(400, 600)).toBeGreaterThan(indent(200, 600));
  });
  it('preserves existing page content', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddText('already here', 72, 780, { fontSize: 10 });
    page.AddHtml('<p>added</p>', [72, 72, 400, 600]);
    const t = textOf(page);
    expect(t).toContain('already here');
    expect(t).toContain('added');
  });
});
describe('doc.AddHtml and the title', () => {
  it("uses the document's <title> when no explicit title is given", () => {
    const doc = Document.New();
    doc.AddHtml(SRC, { format: PageFormat.A4 });
    expect(doc.GetMetadata().title).toBe('Doc Title');
    // A title without the flag satisfies neither PDF/UA nor the caller.
    expect(doc.DisplayDocTitle).toBe(true);
  });
  it('lets an EXPLICIT title win over <title>', () => {
    const doc = Document.New();
    doc.AddHtml(SRC, { format: PageFormat.A4, title: 'Chosen' });
    expect(doc.GetMetadata().title).toBe('Chosen');
  });
  it('leaves the title alone when the source has none', () => {
    const doc = Document.New();
    doc.SetMetadata({ title: 'Existing' });
    doc.AddHtml('<p>no title here</p>', { format: PageFormat.A4 });
    expect(doc.GetMetadata().title).toBe('Existing');
  });
  it('does NOT apply the title default on the other two entry points', () => {
    // Flow.AddHtml and Page.AddHtml append to a document whose title is
    // someone else's business - doc.AddMarkdown's own stated rule.
    const viaFlow = Document.New();
    viaFlow.NewFlow({ format: PageFormat.A4 }).AddHtml(SRC);
    expect(viaFlow.GetMetadata().title).toBeUndefined();
    const viaPage = Document.New();
    viaPage.AddPage(PageFormat.A4).page.AddHtml(SRC, [72, 72, 400, 600]);
    expect(viaPage.GetMetadata().title).toBeUndefined();
  });
  it('rejects an empty explicit title before allocating anything', () => {
    const doc = Document.New();
    const before = doc.Pages.length;
    expect(() => doc.AddHtml('<p>a</p>', { title: '' })).toThrow(TypeError);
    expect(doc.Pages.length).toBe(before);
  });
  it('returns the pages it created plus the report', () => {
    const doc = Document.New();
    const res = doc.AddHtml('<p>a</p><div style="float:left;width:50px">s</div><div style="float:left;width:50px">t</div>',
      { format: PageFormat.A4 });
    expect(res.pages.length).toBeGreaterThan(0);
    expect(names(res.skipped)).toContain('float:left');
  });
  it('parses the source ONCE when given a string', () => {
    // doc.AddHtml parses, reads the title, and hands the tree to flow.AddHtml.
    // Passing a pre-parsed document must behave identically.
    const a = Document.New();
    a.AddHtml(SRC, { format: PageFormat.A4 });
    const b = Document.New();
    b.AddHtml(parseHtml(SRC), { format: PageFormat.A4 });
    expect(textOf(b.Pages[0])).toBe(textOf(a.Pages[0]));
    expect(b.GetMetadata().title).toBe('Doc Title');
  });
});
describe('body margins are honoured', () => {
  it("insets content by the UA sheet's body margin", () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddHtml('<p style="margin:0">x</p>', [72, 72, 400, 600]);
    // body { margin: 8px } = 6pt.
    expect(page.GetTextFragments()[0].quad[0]).toBeCloseTo(72 + 6, 3);
  });
  it('lets an author remove it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddHtml('<style>body{margin:0}</style><p style="margin:0">x</p>',
      [72, 72, 400, 600]);
    expect(page.GetTextFragments()[0].quad[0]).toBeCloseTo(72, 3);
  });
});
describe('public surface', () => {
  it('exports the HTML entry point from the package root', async () => {
    const api = await import('../src/index.js') as Record<string, unknown>;
    expect(typeof api.htmlElements).toBe('function');
    expect(typeof api.parseHtml).toBe('function');
  });
  it('does NOT export the internals', async () => {
    // lowerHtml, documentFamilyResolver and documentTitle are wiring. Keeping
    // them internal is a decision, so the suite enforces it — the rule
    // test/html-public-api.test.ts already applies to parseHtmlFragment.
    const api = await import('../src/index.js') as Record<string, unknown>;
    for (const name of ['lowerHtml', 'documentFamilyResolver', 'documentTitle'])
      expect(api[name]).toBeUndefined();
  });
});