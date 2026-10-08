// test/markdown-footnotes.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { StructElement } from '../src/struct.js';

const pageOf = (pages: { GetText(): string }[], s: string) => pages.findIndex((p) => p.GetText().includes(s));
const count = (t: string, s: string) => t.split(s).length - 1;
const render = (src: string, o: object = {}) => Document.New().AddMarkdown(src, { gfm: true, ...o });

describe('Markdown footnotes through doc.AddMarkdown', () => {
  it('draws the mark and places the note at the page foot', () => {
    const { pages, skipped } = render('A claim.[^1]\n\n[^1]: The SOURCE.\n');
    const f = pages[0].GetTextFragments();
    const body = f.find((x) => x.text.includes('claim'))!;
    const note = f.find((x) => x.text.includes('SOURCE'))!;
    expect(note.quad[1]).toBeLessThan(body.quad[1]);
    expect(note.quad[1]).toBeLessThan(200);
    expect(note.fontSize).toBeCloseTo(8, 1);
    expect(skipped).toEqual([]);
  });
  it("footnotePlacement 'end' makes endnotes after the content", () => {
    const { pages } = render('A.[^1]\n\nclosing paragraph\n\n[^1]: ENDTEXT\n', { footnotePlacement: 'end' });
    const f = pages[0].GetTextFragments();
    expect(f.find((x) => x.text.includes('ENDTEXT'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('closing'))!.quad[1]);
    expect(f.some((x) => x.text === 'i')).toBe(true);
  });
  it('a repeated citation draws one note', () => {
    const { pages } = render('a[^x] b[^x]\n\n[^x]: REPEATED\n');
    expect(count(pages[0].GetText(), 'REPEATED')).toBe(1);
  });
  it('a note may hold a list and code', () => {
    const { pages } = render('t[^n]\n\n[^n]: intro\n\n    - alpha\n    - beta\n\n        codeline\n');
    const t = pages[0].GetText();
    for (const s of ['alpha', 'beta', 'codeline']) expect(t).toContain(s);
  });
  it('a squeeze inside a note body reaches skipped (v9j3.3.5)', () => {
    // Forty quote levels exhaust the column (markdown-squeeze.test.ts) — here
    // inside the definition, so only the note body can report it.
    const { skipped } = render(`t[^n]\n\n[^n]: ${'> '.repeat(40)}deep\n`);
    expect(skipped.filter((s) => s === 'squeezed')).toHaveLength(1);
  });
  it('reports nothing from a note cited only from inside another note (v9j3.3.5)', () => {
    const y = '[^y]: ![pic](nope.png)\n';
    const only = render(`a[^x]\n\n[^x]: see [^y]\n\n${y}`).skipped;
    expect(only).toEqual(['footnote (nested)']);      // y's body is never drawn
    // Positive control: cited from the body, y IS drawn and its image reported.
    const both = render(`a[^x] b[^y]\n\n[^x]: see [^y]\n\n${y}`).skipped;
    expect(both).toContain('image:nope.png');
  });
  it('footnoteSize sets the note body size', () => {
    const { pages } = render('t[^n]\n\n[^n]: SIZED\n', { style: { footnoteSize: 6 } });
    expect(pages[0].GetTextFragments().find((x) => x.text.includes('SIZED'))!.fontSize).toBeCloseTo(6, 1);
  });
  it('a mark in bold text is bold', () => {
    const { pages } = render('**strong[^b]**\n\n[^b]: n\n');
    const mark = pages[0].GetTextFragments().find((x) => x.text === '1' && x.quad[1] > 400)!;
    expect(mark.fontName).toMatch(/Bold/);
  });
  it('text after a citation is drawn AFTER the mark (the mark run is a merge barrier)', () => {
    const { pages } = render('aa[^1]bb\n\n[^1]: n\n');
    const f = pages[0].GetTextFragments();
    const mark = f.find((x) => x.text === '1' && x.quad[1] > 400)!;
    const after = f.find((x) => x.text.includes('bb'))!;
    expect(after.quad[0]).toBeGreaterThan(mark.quad[0]);
  });
  it('a citation in a table cell is drawn as a note (v9j3.3.3 lifted the refusal)', () => {
    const { pages, skipped } = render('t[^a]\n\n| h |\n| - |\n| c[^a] |\n\n[^a]: n\n');
    expect(pages[0].GetText()).not.toContain('[^a]');
    expect(skipped).not.toContain('footnote (table cell)');
  });
  it('a citation inside a note is literal and reported', () => {
    const { pages, skipped } = render('t[^a]\n\n[^a]: see[^b]\n[^b]: B\n');
    expect(pages[0].GetText()).toContain('[^b]');
    expect(skipped).toContain('footnote (nested)');
  });
  it('an undefined reference is drawn literally and not reported (Review Focus 5)', () => {
    const { pages, skipped } = render('x[^nope] y\n');
    expect(pages[0].GetText()).toContain('[^nope]');
    expect(skipped).toEqual([]);
  });
  it('a citation in a heading, a quote and a list item (Review Focus 2, 4)', () => {
    const { pages } = render('# Title[^h]\n\n> quoted[^q]\n\n- item[^l]\n\n[^h]: HNOTE\n[^q]: QNOTE\n[^l]: LNOTE\n');
    const t = pages[0].GetText();
    for (const s of ['HNOTE', 'QNOTE', 'LNOTE']) expect(t).toContain(s);
  });
  it('fifty footnotes all render in order (Review Focus 1)', () => {
    const body = Array.from({ length: 50 }, (_, i) => `p${i}[^n${i}]`).join('\n\n');
    const defs = Array.from({ length: 50 }, (_, i) => `[^n${i}]: NOTE${i}X`).join('\n');
    const { pages } = render(`${body}\n\n${defs}\n`);
    const all = pages.map((p) => p.GetText()).join('\n');
    for (let i = 0; i < 50; i++) expect(all).toContain(`NOTE${i}X`);
    expect(all.indexOf('NOTE0X')).toBeLessThan(all.indexOf('NOTE49X'));
  });
  it('tagged: one /Note per definition, inside the citing /P', () => {
    const doc = Document.New();
    doc.AddMarkdown('a[^x] b[^x]\n\n[^x]: n\n', { gfm: true, tagged: true });
    const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
    const notes = all(doc.GetStructTree()!).filter((e) => e.Type === 'Note');
    expect(notes).toHaveLength(1);
    expect(notes[0].Parent!.Type).toBe('P');
  });
  it('gfm off: [^1] is no footnote — CommonMark reads [^1]: n as a link reference', () => {
    const { pages } = Document.New().AddMarkdown('a[^1]\n\n[^1]: n\n');
    expect(pages[0].GetText()).toContain('a^1');
    expect(Document.New().AddMarkdown('x[^2] y\n').pages[0].GetText()).toContain('[^2]');
  });
  it('refuses a bad footnotePlacement and footnoteSize before allocating', () => {
    expect(() => render('x', { footnotePlacement: 'side' })).toThrow(TypeError);
    expect(() => render('x', { style: { footnoteSize: 0 } })).toThrow(TypeError);
  });
});

describe('page.AddMarkdown', () => {
  it('places the notes after the content inside the rect', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const r = page.AddMarkdown('A claim.[^1]\n\n[^1]: RECTNOTE\n', [72, 72, 400, 700], { gfm: true });
    const f = page.GetTextFragments();
    expect(f.find((x) => x.text.includes('RECTNOTE'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('claim'))!.quad[1]);
    expect(r.remainder).toEqual([]);
  });
  it('notes that do not fit come back in the remainder', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const r = page.AddMarkdown('A.[^1]\n\n[^1]: ' + 'word '.repeat(400) + '\n', [72, 600, 400, 40], { gfm: true });
    expect(r.remainder.length).toBeGreaterThan(0);
  });
});

describe('review fixes (v9j3.3.1)', () => {
  const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
  const tagged = (src: string) => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const sect = doc.CreateStructTree().Append('Sect');
    sect.Lang = 'en-US';
    page.AddMarkdown(src, [72, 72, 451, 698], { gfm: true, structParent: sect });
    doc.SetMetadata({ title: 'T' });
    doc.DisplayDocTitle = true;
    return doc;
  };
  it('tagged page.AddMarkdown makes one /Note and reports nothing a note-free render does not', () => {
    const doc = tagged('A.[^1]\n\n[^1]: N\n');
    expect(all(doc.GetStructTree()!).filter((e) => e.Type === 'Note')).toHaveLength(1);
    const rules = (d: Document) => d.ValidatePdfUa().Issues.map((i) => i.rule).sort();
    expect(rules(doc)).toEqual(rules(tagged('A.\n\nN\n')));
  });
  const markAndBody = (pages: { GetTextFragments(): { text: string; fontSize: number; quad: number[] }[] }[], body: string) => {
    const f = pages[0].GetTextFragments();
    const b = f.find((x) => x.text.includes(body))!;
    const m = f.find((x) => x.text === 'i' && Math.abs(x.quad[1] - b.quad[1]) < 4)!;
    return { mark: m.fontSize, body: b.fontSize };
  };
  it("the endnote gutter mark is sized from the 8pt body in 'end' mode (doc.AddMarkdown)", () => {
    const { pages } = render('A.[^1]\n\nclosing\n\n[^1]: ENDTEXT\n', { footnotePlacement: 'end' });
    const s = markAndBody(pages, 'ENDTEXT');
    expect(s.body).toBeCloseTo(8, 1);
    expect(s.mark).toBeCloseTo(8 * 0.6, 1);
  });
  it("the endnote gutter mark is sized from the 8pt body in 'end' mode (page.AddMarkdown)", () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    page.AddMarkdown('A.[^1]\n\n[^1]: ENDTEXT\n', [72, 72, 400, 700], { gfm: true, footnotePlacement: 'end' });
    const s = markAndBody([page], 'ENDTEXT');
    expect(s.mark).toBeCloseTo(s.body * 0.6, 1);
  });
  it('flow.AddMarkdown maps the note body at the flow\'s own note size', () => {
    const flow = Document.New().NewFlow({ endnotes: { fontSize: 12 } });
    flow.AddMarkdown('A.[^1]\n\n[^1]: ENDTEXT\n', { gfm: true, footnotePlacement: 'end' });
    const s = markAndBody(flow.Render(), 'ENDTEXT');
    expect(s.body).toBeCloseTo(12, 1);
    expect(s.mark).toBeCloseTo(12 * 0.6, 1);
  });
});
