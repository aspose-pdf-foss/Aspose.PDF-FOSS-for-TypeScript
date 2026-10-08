import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageGraphics } from '../src/graphics.js';
import { decodePng } from './helpers/decode-png.js';
import type { Page } from '../src/page.js';

// v9j3.5: Flow's per-page callbacks. `onPage(page, index)` runs as each page
// is created, before content lands on it; `onRendered(pages)` once after
// layout, knowing the count. In a tagged flow what either draws is an
// /Artifact /Pagination sequence.
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

type Opts = Parameters<Document['NewFlow']>[0];
function threePages(opts: Opts | ((d: Document) => Opts) = {}): { d: Document; pages: Page[] } {
  const d = Document.New();
  const flow = d.NewFlow(typeof opts === 'function' ? opts(d) : opts);
  for (let i = 0; i < 3; i++) { flow.AddParagraph(words(40)); if (i < 2) flow.AddColumnBreak(); }
  return { d, pages: flow.Render() };
}

describe('onPage', () => {
  it('runs once per page, in order, with its 0-based index, before content lands', () => {
    const seen: Array<[number, number]> = [];
    const { pages } = threePages({
      onPage: (page, index) => { seen.push([index, page.GetText().length]); },
    });
    expect(pages).toHaveLength(3);
    expect(seen).toEqual([[0, 0], [1, 0], [2, 0]]);
  });
  it('what it draws sits UNDER the flow content', () => {
    const { pages } = threePages((d) => ({
      onPage: (page) => { new PageGraphics(d, page).setFillColor([1, 0, 0]).rect(0, 0, 595, 842).fill().apply(); },
    }));
    const png = decodePng(pages[0].ToImage({ scale: 1 }));
    // A page-filling red rect drawn first: red where there is no text, and the
    // text's black still visible over it, not hidden.
    expect(png.at(10, 10).slice(0, 3)).toEqual([255, 0, 0]);
    let dark = 0;
    for (let y = 72; y < 120; y++) for (let x = 72; x < 400; x++) { const [r, g] = png.at(x, y); if (r < 80 && g < 80) dark++; }
    expect(dark).toBeGreaterThan(50);
  });
});

describe('onRendered', () => {
  it('runs once after layout with every page, so a footer can say "Page i of N"', () => {
    let calls = 0;
    const { pages } = threePages({
      onRendered: (ps) => {
        calls++;
        ps.forEach((p, i) => p.AddText(`Page ${i + 1} of ${ps.length}`, 72, 40));
      },
    });
    expect(calls).toBe(1);
    expect(pages[2].GetText()).toContain('Page 3 of 3');
    expect(pages[0].GetText()).toContain('Page 1 of 3');
  });
  it('is handed the same pages Render returns', () => {
    let got: Page[] = [];
    const { pages } = threePages({ onRendered: (ps) => { got = ps; } });
    expect(got).toEqual(pages);
  });
});

describe('validation', () => {
  it('refuses a non-function before anything is allocated', () => {
    const d = Document.New();
    expect(() => d.NewFlow({ onPage: 1 as never })).toThrow(TypeError);
    expect(() => d.NewFlow({ onRendered: 'x' as never })).toThrow(TypeError);
    expect(d.Pages).toHaveLength(0);
  });
  it('a throwing callback propagates out of Render', () => {
    const d = Document.New();
    const flow = d.NewFlow({ onPage: () => { throw new Error('boom'); } });
    flow.AddParagraph('x');
    expect(() => flow.Render()).toThrow('boom');
  });
});

describe('tagged flows artifact what the callbacks draw', () => {
  const tagged = (): Document => {
    const { d } = threePages({
      tagged: true, lang: 'en',
      onPage: (page) => { page.AddText('Running head', 72, 800); },
      onRendered: (ps) => ps.forEach((p, i) => p.AddText(`Page ${i + 1}`, 72, 40)),
    });
    d.SetMetadata({ title: 'T' });
    d.DisplayDocTitle = true;
    return Document.Open(d.Save());
  };
  it('passes ValidatePdfUa with no untagged content', () => {
    const r = tagged().ValidatePdfUa();
    expect(r.Issues.filter((e) => e.rule === 'UntaggedContent')).toEqual([]);
  });
  it('reports each as a Pagination artifact', () => {
    const arts = tagged().Pages[1].Artifacts.filter((a) => a.type === 'Pagination');
    expect(arts.length).toBe(2);
  });
  it('artifacts an underlay too (text drawn behind the content)', () => {
    const { d } = threePages({
      tagged: true,
      onRendered: (ps) => ps.forEach((p) => p.AddText('DRAFT', 200, 400, { behind: true, fontSize: 60 })),
    });
    const arts = Document.Open(d.Save()).Pages[0].Artifacts.filter((a) => a.type === 'Pagination');
    expect(arts.length).toBe(1);
  });
  it('closes the scope: content drawn after Render is not artifacted', () => {
    const { d, pages } = threePages({ tagged: true, onRendered: () => undefined });
    pages[0].AddText('later', 72, 40);
    expect(Document.Open(d.Save()).Pages[0].Artifacts.filter((a) => a.type === 'Pagination')).toEqual([]);
  });
  it('leaves a body the caller already artifacted or tagged alone (no nesting)', () => {
    const d = Document.New();
    const flow = d.NewFlow({
      tagged: true,
      onPage: (page) => { page.AddText('decor', 72, 800, { artifact: true } as never); },
    });
    flow.AddParagraph('x');
    flow.Render();
    const raw = Buffer.from(d.Pages[0].Contents).toString('latin1');
    expect(raw).not.toMatch(/\/Pagination[^]*?BDC\s*\/Artifact\s*BMC/);
  });
});

describe('an untagged flow is unchanged by the scope', () => {
  it('callback output is written exactly as the same calls made after Render', () => {
    const draw = (p: Page, i: number): void => { p.AddText(`Page ${i + 1}`, 72, 40); };
    const a = threePages({ onRendered: (ps) => ps.forEach(draw) }).d;
    const b = threePages();
    b.pages.forEach(draw);
    const h = (d: Document): string => createHash('sha256').update(d.Save()).digest('hex');
    expect(h(a)).toBe(h(b.d));
  });
});

describe('doc.AddMarkdown forwards the hooks', () => {
  it('runs onPage and onRendered for the flow it builds', () => {
    const d = Document.New();
    let created = 0, rendered = 0;
    d.AddMarkdown('# Title\n\nBody.', { onPage: () => { created++; }, onRendered: (ps) => { rendered = ps.length; } });
    expect(created).toBe(1);
    expect(rendered).toBe(1);
  });
});
