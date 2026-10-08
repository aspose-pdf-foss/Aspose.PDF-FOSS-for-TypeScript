// test/flow-note-links.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';
import { placeElements } from '../src/flowplace.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';
import type { StructElement } from '../src/struct.js';
import type { PdfObject } from '../src/types.js';

type Frag = { text: string; fontSize: number; quad: number[] };
type Pg = { Number: number; GetTextFragments(): Frag[]; GetText(): string; Annotations: unknown[] };
type Goto = { rect: [number, number, number, number]; page: number; left?: number | null; top?: number | null };
type Uri = { rect: [number, number, number, number]; uri: string };

function gotos(pg: Pg): Goto[] {
  return (pg.Annotations as Array<{ Rect?: [number, number, number, number]; Action?: { type: string; page?: number; view?: { left?: number | null; top?: number | null } } }>)
    .filter((a) => a.Action?.type === 'goto')
    .map((a) => ({ rect: a.Rect!, page: a.Action!.page!, left: a.Action!.view?.left, top: a.Action!.view?.top }));
}
function uris(pg: Pg): Uri[] {
  return (pg.Annotations as Array<{ Rect?: [number, number, number, number]; Action?: { type: string; uri?: string } }>)
    .filter((a) => a.Action?.type === 'uri').map((a) => ({ rect: a.Rect!, uri: a.Action!.uri! }));
}
/** A fragment's left edge lies in the rect and its baseline in its band. */
const covers = (rect: number[], f: Frag) =>
  f.quad[0] >= rect[0] - 0.5 && f.quad[0] < rect[2] && f.quad[1] >= rect[1] - 2 && f.quad[1] <= rect[3];
const small = (pg: Pg, t: string) => pg.GetTextFragments().filter((f) => f.text.trim() === t && f.fontSize < 8);
const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);

describe('note links', () => {
  it('the mark links to its note, the note’s mark links back (same page)', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'A claim' }, { text: '', footnote: { content: 'NOTEBODY' } }]);
    const [pg] = flow.Render() as unknown as Pg[];
    const links = gotos(pg);
    expect(links).toHaveLength(2);
    const [cite, gutter] = small(pg, '1').sort((a, b) => b.quad[1] - a.quad[1]);   // citation is higher
    const body = pg.GetTextFragments().find((f) => f.text.includes('NOTEBODY'))!;
    const toNote = links.find((l) => covers(l.rect, cite))!;
    expect(toNote.page).toBe(pg.Number);
    expect(toNote.top!).toBeGreaterThanOrEqual(body.quad[1]);
    expect(toNote.top!).toBeLessThan(body.quad[1] + 20);
    const back = links.find((l) => covers(l.rect, gutter))!;
    expect(back.page).toBe(pg.Number);
    expect(back.top!).toBeGreaterThanOrEqual(cite.quad[1]);
    expect(back.top!).toBeLessThan(cite.quad[1] + 20);
  });

  it('links cross pages: an endnote on a new page (Review Focus 1)', () => {
    const flow = Document.New().NewFlow({ endnotes: { newPage: true } });
    flow.AddParagraph([{ text: 'cited here' }, { text: '', endnote: { content: 'ENDBODY' } }]);
    const pages = flow.Render() as unknown as Pg[];
    expect(pages.length).toBe(2);
    expect(gotos(pages[0]).map((l) => l.page)).toEqual([pages[1].Number]);
    expect(gotos(pages[1]).map((l) => l.page)).toEqual([pages[0].Number]);
  });

  it('a repeated citation: two links to the note, one back link to the first (Review Focus 2)', () => {
    const n = { content: 'SHARED' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'first' }, { text: '', footnote: n }]);
    flow.AddParagraph('x '.repeat(40));
    flow.AddParagraph([{ text: 'again' }, { text: '', footnote: n }]);
    const [pg] = flow.Render() as unknown as Pg[];
    const links = gotos(pg);
    expect(links).toHaveLength(3);
    const firstY = pg.GetTextFragments().find((f) => f.text.includes('first'))!.quad[1];
    const shared = pg.GetTextFragments().find((f) => f.text.includes('SHARED'))!.quad[1];
    const toNote = links.filter((l) => l.top! < firstY - 50);          // targets at the foot
    expect(toNote).toHaveLength(2);
    const back = links.filter((l) => l.rect[3] < shared + 15);          // the one on the note's line
    expect(back).toHaveLength(1);
    expect(back[0].top!).toBeGreaterThanOrEqual(firstY);
    expect(back[0].top!).toBeLessThan(firstY + 20);
  });

  it('a table-cell mark links to its note', () => {
    const t = createTable();
    t.addRow().addCell([{ text: 'cell' }, { text: '', footnote: { content: 'CELLNOTE' } }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const [pg] = flow.Render() as unknown as Pg[];
    expect(gotos(pg)).toHaveLength(2);
  });

  it('page.AddMarkdown (one rect) links both ways', () => {
    const doc = Document.New();
    const page = doc.AddPage().page as unknown as Pg & { AddMarkdown: Function };
    page.AddMarkdown('A claim.[^1]\n\n[^1]: THE NOTE\n', [72, 72, 450, 700], { gfm: true });
    expect(gotos(page)).toHaveLength(2);
  });

  it('a cited URI run keeps its URI; its mark goes to the note (Review Focus 5)', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'docs', link: 'https://example.com/d', footnote: { content: 'N' } }, { text: ' after' }]);
    const [pg] = flow.Render() as unknown as Pg[];
    const u = uris(pg);
    expect(u).toHaveLength(1);
    expect(covers(u[0].rect, pg.GetTextFragments().find((f) => f.text.includes('docs'))!)).toBe(true);
    const cite = small(pg, '1').sort((a, b) => b.quad[1] - a.quad[1])[0];
    expect(u.some((l) => covers(l.rect, cite))).toBe(false);
    expect(gotos(pg).some((l) => covers(l.rect, cite))).toBe(true);
  });

  it('links: false writes no annotation (Review Focus 4)', () => {
    const flow = Document.New().NewFlow({ footnotes: { links: false }, endnotes: { links: false } });
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'F' } }, { text: ' b' }, { text: '', endnote: { content: 'E' } }]);
    for (const pg of flow.Render() as unknown as Pg[]) expect(pg.Annotations).toHaveLength(0);
  });

  it('links is per kind', () => {
    const flow = Document.New().NewFlow({ endnotes: { links: false } });
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'F' } }, { text: ' b' }, { text: '', endnote: { content: 'E' } }]);
    const pages = flow.Render() as unknown as Pg[];
    expect(pages.flatMap(gotos)).toHaveLength(2);
  });

  it('refuses a links option that is not a boolean', () => {
    expect(() => Document.New().NewFlow({ footnotes: { links: 'yes' as never } })).toThrow(/footnotes.links must be a boolean/);
  });

  it('tagged: each link is a /Link with the mark and its /OBJR; PDF/UA reports nothing new (Review Focus 3)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true, lang: 'en' });
    flow.AddParagraph([{ text: 'A claim' }, { text: '', footnote: { content: 'NOTEBODY' } }]);
    flow.Render();
    const linkEls = all(doc.GetStructTree()!).filter((e) => e.Type === 'Link');
    expect(linkEls.map((e) => e.Parent!.Type).sort()).toEqual(['Note', 'P']);
    for (const el of linkEls) {
      expect(el.GetText()).toContain('1');
      const k = doc.resolve(el.Dict.get('K') ?? null);
      const kids = (Array.isArray(k) ? k : [k]).map((x: PdfObject) => doc.resolve(x));
      expect(kids.some((x) => x instanceof Map && (x.get('Type') as { name?: string } | undefined)?.name === 'OBJR')).toBe(true);
    }
    const report = doc.ValidatePdfUa();
    expect(report.Issues.filter((i) => i.rule === 'UntaggedContent' || /Link|Annot/i.test(i.rule))).toEqual([]);
  });

  it('a tagged citation or note left unlinked is not a hollow /Link (final review #1)', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const sect = doc.CreateStructTree().Append('Sect');
    const filler = Array.from({ length: 30 }, (_, i) => `Filler sentence ${i} fills the rect.`).join(' ');
    // The note overflows into the remainder: no annotation for the citation.
    const res = page.AddMarkdown(`Claim.[^1]\n\n${filler}\n\n[^1]: THE NOTE text\n`, [72, 600, 300, 80],
      { gfm: true, structParent: sect });
    expect(res.remainder).not.toBeNull();
    // Continued later, as the docs advise: the note draws after finish().
    const p2 = doc.AddPage().page;
    const hasObjr = (el: StructElement): boolean => {
      const k = doc.resolve(el.Dict.get('K') ?? null);
      return (Array.isArray(k) ? k : [k]).map((x: PdfObject) => doc.resolve(x))
        .some((x) => x instanceof Map && (x.get('Type') as { name?: string } | undefined)?.name === 'OBJR');
    };
    const hollow = (): StructElement[] => all(doc.GetStructTree()!).filter((e) => e.Type === 'Link' && !hasObjr(e));
    expect(hollow()).toEqual([]);
    placeElements(doc, p2, res.remainder!, [72, 72, 450, 700], { structParent: sect });
    expect(hollow()).toEqual([]);
    expect(p2.GetText()).toContain('THE NOTE');
  });

  it('Markdown and DOCX documents link their notes', () => {
    const md = Document.New().AddMarkdown('A claim.[^1]\n\n[^1]: NOTE\n', { gfm: true });
    expect((md.pages as unknown as Pg[]).flatMap(gotos)).toHaveLength(2);
    const bytes = buildDocx(p(r('A claim.') + '<w:r><w:footnoteReference w:id="1"/></w:r>'),
      { footnotes: '<w:footnote w:id="1">' + p(r('NOTE')) + '</w:footnote>' });
    const dx = Document.New().AddDocx(bytes);
    expect((dx.pages as unknown as Pg[]).flatMap(gotos)).toHaveLength(2);
  });
});
