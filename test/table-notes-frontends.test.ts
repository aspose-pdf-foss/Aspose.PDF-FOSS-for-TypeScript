// test/table-notes-frontends.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

type Frag = { text: string; fontSize: number; quad: number[] };
type Pg = { GetTextFragments(): Frag[]; GetText(): string };
const gutterOf = (pages: Pg[], body: string): string | undefined => {
  for (const pg of pages) {
    const f = pg.GetTextFragments();
    const b = f.find((x) => x.text.includes(body));
    if (b !== undefined)
      return f.find((x) => x.fontSize < b.fontSize && Math.abs(x.quad[1] - b.quad[1]) < b.fontSize * 0.6 && x.quad[0] < b.quad[0])?.text.trim();
  }
  return undefined;
};
const MD = 'Text.[^a]\n\n| head |\n| - |\n| cell[^b] |\n\n[^a]: FIRSTNOTE\n[^b]: CELLNOTE\n';
const fnRef = (id: string) => `<w:r><w:footnoteReference w:id="${id}"/></w:r>`;
const fn = (id: string, body: string) => `<w:footnote w:id="${id}">${body}</w:footnote>`;
const tbl = (inner: string) => '<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>' + inner + '</w:tc></w:tr></w:tbl>';
const DOCX = () => buildDocx(p(r('Text.') + fnRef('1')) + tbl(p(r('cell') + fnRef('2'))) + p(r('after')),
  { footnotes: fn('1', p(r('FIRSTNOTE'))) + fn('2', p(r('CELLNOTE'))) });

describe('Markdown table cells cite notes', () => {
  it('doc.AddMarkdown: drawn, numbered in order, nothing reported', () => {
    const { pages, skipped } = Document.New().AddMarkdown(MD, { gfm: true });
    expect(pages[0].GetText()).not.toContain('[^b]');
    expect(gutterOf(pages, 'FIRSTNOTE')).toBe('1');
    expect(gutterOf(pages, 'CELLNOTE')).toBe('2');
    expect(skipped).toEqual([]);
  });
  it('a cell citing the same definition as a paragraph repeats its mark; the note is drawn once', () => {
    const { pages } = Document.New().AddMarkdown('Text.[^a]\n\n| h |\n| - |\n| c[^a] |\n\n[^a]: ONCE\n', { gfm: true });
    const t = pages.map((pg) => pg.GetText()).join('\n');
    expect(t.split('ONCE').length - 1).toBe(1);
    expect(t).not.toContain('[^a]');
  });
  it('flow.AddMarkdown', () => {
    const flow = Document.New().NewFlow();
    flow.AddMarkdown(MD, { gfm: true });
    expect(gutterOf(flow.Render(), 'CELLNOTE')).toBe('2');
  });
  it('page.AddMarkdown places the cell note after the content inside the rect (Review Focus 5)', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const res = page.AddMarkdown(MD, [72, 72, 450, 700], { gfm: true });
    expect(res.skipped).toEqual([]);
    expect(gutterOf([page], 'CELLNOTE')).toBe('2');
    const f = page.GetTextFragments();
    expect(f.find((x) => x.text.includes('CELLNOTE'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('cell'))!.quad[1]);
  });
  it("footnotePlacement 'end' makes a cell citation an endnote", () => {
    const { pages } = Document.New().AddMarkdown(MD, { gfm: true, footnotePlacement: 'end' });
    expect(gutterOf(pages, 'CELLNOTE')).toBe('ii');
  });
});

describe('DOCX table cells cite notes', () => {
  it('doc.AddDocx: drawn, numbered in order, nothing reported', () => {
    const { pages, skipped } = Document.New().AddDocx(DOCX());
    expect(gutterOf(pages, 'FIRSTNOTE')).toBe('1');
    expect(gutterOf(pages, 'CELLNOTE')).toBe('2');
    expect(skipped.filter((s) => s.name.includes('Reference'))).toEqual([]);
  });
  it('flow.AddDocx', () => {
    const flow = Document.New().NewFlow();
    flow.AddDocx(DOCX());
    expect(gutterOf(flow.Render(), 'CELLNOTE')).toBe('2');
  });
  it('page.AddDocx (Review Focus 5)', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const res = page.AddDocx(DOCX(), [72, 72, 450, 700]);
    expect(res.skipped.filter((s) => s.name.includes('Reference'))).toEqual([]);
    expect(gutterOf([page], 'CELLNOTE')).toBe('2');
  });
  it('a reference inside a note is still reported (in a note)', () => {
    const bytes = buildDocx(p(r('t') + fnRef('1')),
      { footnotes: fn('1', tbl(p(r('INNER') + fnRef('2')))) + fn('2', p(r('NESTED'))) });
    const { pages, skipped } = Document.New().AddDocx(bytes);
    expect(pages.map((pg) => pg.GetText()).join('\n')).not.toContain('NESTED');
    expect(skipped).toContainEqual({ name: 'w:footnoteReference (in a note)', count: 1, kind: 'dropped' });
  });
  // Word spells section 1 in arabic and section 2 in lowercase roman; the engine
  // takes ONE format, the last section's (v9j3.3.2, reported), so the drawn
  // marks are compared by NUMBER: the cell note must be the third in section 1.
  it('Word 2010 corpus: the numbers drawn are Word’s, the cell note included', () => {
    const value = (m: string | undefined): number | string | undefined => {
      if (m === undefined || !/^([0-9]+|[ivxlc]+)$/.test(m)) return m;
      if (/^[0-9]+$/.test(m)) return Number(m);
      const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
      let n = 0;
      for (let k = 0; k < m.length; k++) n += v[m[k]] < (v[m[k + 1]] ?? 0) ? -v[m[k]] : v[m[k]];
      return n;
    };
    const dir = join('test', 'fixtures', 'docx');
    const truth = JSON.parse(readFileSync(join(dir, 'word2010-notes.word.json'), 'utf8')) as
      { notes: { footnotes: { mark: string; text: string }[] } };
    const { pages } = Document.New().AddDocx(new Uint8Array(readFileSync(join(dir, 'word2010-notes.docx'))));
    const drawn = truth.notes.footnotes.map((n) => gutterOf(pages, n.text.split('\n')[0].replace(/\.$/, '')));
    expect(drawn.map(value)).toEqual(truth.notes.footnotes.map((n) => value(n.mark)));
  });
});
