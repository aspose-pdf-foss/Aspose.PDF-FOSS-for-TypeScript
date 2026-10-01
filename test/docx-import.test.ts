import { describe, it, expect } from 'vitest';
import { Document, PageFormat } from '../src/index.js';
import { PdfParseError } from '../src/errors.js';
import { buildDocx, type DocxParts } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

const render = (body: string, parts: DocxParts = {}, opts = {}) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body, parts), opts);
  return { doc, ...res, text: res.pages.map((pg) => pg.GetText()).join('\n') };
};

describe('AddDocx: paragraphs', () => {
  it('renders every paragraph\'s text in order through doc.AddDocx', () => {
    const { text, skipped } = render(p(r('First paragraph.')) + p(r('Second one.')));
    expect(text).toMatch(/First paragraph\.[\s\S]*Second one\./);
    expect(skipped).toEqual([]);
  });

  it('keeps an empty paragraph as vertical space', () => {
    const y = (body: string) => {
      const { doc } = render(body);
      return doc.Pages[0].GetTextFragments().find((f) => f.text.includes('B'))!.quad[1];
    };
    expect(y(p(r('A')) + p(r('B')))).toBeGreaterThan(y(p(r('A')) + p('') + p(r('B'))) + 5);
  });

  it('starts a new page at a page break', () => {
    const { pages } = render(p(r('before') + '<w:r><w:br w:type="page"/></w:r>' + r('after')));
    expect(pages.length).toBe(2);
    expect(pages[1].GetText()).toContain('after');
  });

  it('passes readDocx\'s records through, with a kind, counted and sorted', () => {
    const body = p('<w:r><w:footnoteReference w:id="1"/></w:r>' + r('x'))
      + p('<w:r><w:footnoteReference w:id="2"/></w:r>' + '<w:ins w:id="1" w:author="a">' + r('y') + '</w:ins>');
    expect(render(body).skipped).toEqual([
      { name: 'w:footnoteReference', count: 2, kind: 'dropped' },
      { name: 'w:ins', count: 1, kind: 'degraded' },
    ]);
  });

  it('returns a fresh skipped array on every call', () => {
    const doc = Document.New();
    const a = doc.AddDocx(buildDocx(p(r('x')))).skipped;
    a.push({ name: 'mine', count: 1, kind: 'dropped' });
    expect(doc.AddDocx(buildDocx(p(r('x')))).skipped).toEqual([]);
  });

  it('refuses a non-function resolveFamily or onSkipped before allocating a page', () => {
    const doc = Document.New();
    const before = doc.Pages.length;
    expect(() => doc.AddDocx(buildDocx(p(r('x'))), { onSkipped: 3 as never })).toThrow(TypeError);
    expect(() => doc.AddDocx(buildDocx(p(r('x'))), { resolveFamily: 'x' as never })).toThrow(TypeError);
    expect(doc.Pages.length).toBe(before);
  });

  it('takes the page size and margins from the last section, unless the caller states them', () => {
    const sect = '<w:sectPr><w:pgSz w:w="6000" w:h="8000"/><w:pgMar w:top="400" w:right="600" w:bottom="400" w:left="1000"/></w:sectPr>';
    const { pages } = render(p(r('sized')) + sect);
    expect(pages[0].MediaBox.slice(2)).toEqual([300, 400]);
    expect(pages[0].GetTextFragments()[0].quad[0]).toBeCloseTo(50, 1);
    const stated = render(p(r('sized')) + sect, {}, { marginLeft: 20 });
    expect(stated.pages[0].MediaBox.slice(2)).toEqual([300, 400]);
    expect(stated.pages[0].GetTextFragments()[0].quad[0]).toBeCloseTo(20, 1);
  });

  it('reads a signed page margin by its magnitude, as Word places the text', () => {
    const sect = '<w:sectPr><w:pgSz w:w="6000" w:h="8000"/><w:pgMar w:top="-400" w:right="600" w:bottom="400" w:left="1000"/></w:sectPr>';
    const { pages, skipped } = render(p(r('signed')) + sect);
    expect(skipped).toEqual([]);
    const f = pages[0].GetTextFragments()[0];
    expect(f.quad[3]).toBeLessThanOrEqual(400 - 20 + 0.01);
    expect(f.quad[3]).toBeGreaterThan(400 - 20 - 20);
  });

  it('drops page margins that leave no column, and reports them', () => {
    const wide = '<w:sectPr><w:pgSz w:w="6000" w:h="8000"/><w:pgMar w:top="400" w:right="4000" w:bottom="400" w:left="4000"/></w:sectPr>';
    const a = render(p(r('wide')) + wide);
    expect(a.text).toContain('wide');
    expect(a.skipped).toContainEqual({ name: 'w:pgMar', count: 1, kind: 'degraded' });
    // The caller's own format against the document's margins: the same rule.
    const tall = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="7000" w:right="1440" w:bottom="7000" w:left="1440"/></w:sectPr>';
    const b = render(p(r('tall')) + tall, {}, { format: PageFormat.custom(612, 300) });
    expect(b.text).toContain('tall');
    expect(b.skipped).toContainEqual({ name: 'w:pgMar', count: 1, kind: 'degraded' });
  });

  it('still refuses margins the CALLER states that leave no column', () => {
    expect(() => render(p(r('x')), {}, { marginLeft: 400, marginRight: 400 })).toThrow(TypeError);
  });

  it('throws PdfParseError for bytes that are not a WordprocessingML package', () => {
    expect(() => Document.New().AddDocx(new Uint8Array([1, 2, 3]))).toThrow(PdfParseError);
  });
});

describe('AddDocx: the three entry points agree', () => {
  const body = p(r('Alpha words.')) + p(r('Beta words.'));
  it('flow.AddDocx, page.AddDocx and doc.AddDocx extract the same text', () => {
    const viaDoc = Document.New(); viaDoc.AddDocx(buildDocx(body));
    const viaFlow = Document.New(); const f = viaFlow.NewFlow(); f.AddDocx(buildDocx(body)); f.Render();
    const viaPage = Document.New(); const pg = viaPage.AddPage().page;
    pg.AddDocx(buildDocx(body), [72, 72, 451, 698]);
    const norm = (d: Document) => d.Pages[0].GetText().replace(/\s+/g, ' ').trim();
    expect(norm(viaDoc)).toBe('Alpha words. Beta words.');
    expect(norm(viaFlow)).toBe(norm(viaDoc));
    expect(norm(viaPage)).toBe(norm(viaDoc));
  });

  it('page.AddDocx reports a page break it cannot honour', () => {
    const pg = Document.New().AddPage().page;
    const res = pg.AddDocx(buildDocx(p(r('a') + '<w:r><w:br w:type="page"/></w:r>' + r('b'))), [72, 72, 451, 698]);
    expect(res.skipped).toContainEqual({ name: 'w:br (page)', count: 1, kind: 'degraded' });
    expect(pg.GetText()).toMatch(/a[\s\S]*b/);
  });
});
