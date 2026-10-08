// test/flow-table-notes.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable, type TableBuilder } from '../src/tableauthor.js';
import { table } from '../src/flowtable.js';
import type { StructElement } from '../src/struct.js';

type Frag = { text: string; fontSize: number; quad: number[] };
type Pg = { GetTextFragments(): Frag[]; GetText(): string };
const fn = (c: string) => ({ footnote: { content: c } });
const filler = (n: number) => Array.from({ length: n }, (_, i) => `Body sentence ${i} fills the page.`).join(' ');
const pageOf = (pages: Pg[], s: string) => pages.findIndex((p) => p.GetText().includes(s));
/** The gutter mark left of a note body: small, same line, to its left. */
function gutterOf(p: Pg, body: string): string | undefined {
  const f = p.GetTextFragments();
  const b = f.find((x) => x.text.includes(body));
  if (b === undefined) return undefined;
  return f.find((x) => x.fontSize < b.fontSize && Math.abs(x.quad[1] - b.quad[1]) < 4 && x.quad[0] < b.quad[0])?.text.trim();
}
const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
const cited = (label: string, note: string) => [{ text: label }, { text: '', ...fn(note) }];

describe('notes in Flow table cells', () => {
  it('a cell footnote is drawn at the page foot, its mark raised in the cell', () => {
    const t = createTable();
    t.addRow().addCell(cited('cell', 'CELLNOTE'));
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const [p] = flow.Render();
    const f = p.GetTextFragments();
    const note = f.find((x) => x.text.includes('CELLNOTE'))!;
    expect(note.quad[1]).toBeLessThan(200);
    expect(note.quad[1]).toBeLessThan(f.find((x) => x.text.includes('cell'))!.quad[1]);
    expect(f.filter((x) => x.text.trim() === '1' && x.fontSize < 8)).toHaveLength(2);   // citation + gutter
  });

  it("a cell's mark is sized from the cell's own cascaded size, not the table's", () => {
    const t = createTable({ fontSize: 10 });
    t.addRow().addCell(cited('big', 'BIGNOTE'), { fontSize: 20 });
    t.rows[0].addCell(cited('small', 'SMALLNOTE'));
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const f = flow.Render()[0].GetTextFragments();
    const markBeside = (label: string): Frag => {
      const b = f.find((x) => x.text.includes(label) && !x.text.includes('NOTE'))!;
      return f.find((x) => /^\d$/.test(x.text.trim()) && x.fontSize < b.fontSize && x.quad[0] > b.quad[0] && Math.abs(x.quad[1] - b.quad[1]) < b.fontSize)!;
    };
    expect(markBeside('big').fontSize).toBeGreaterThan(markBeside('small').fontSize * 1.5);
  });

  it('numbers cells row-major', () => {
    const t = createTable();
    t.addRow().addCell(cited('a', 'N00')); t.rows[0].addCell(cited('b', 'N01'));
    t.addRow().addCell(cited('c', 'N10')); t.rows[1].addCell(cited('d', 'N11'));
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const [p] = flow.Render();
    expect(['N00', 'N01', 'N10', 'N11'].map((s) => gutterOf(p, s))).toEqual(['1', '2', '3', '4']);
  });

  it('a split table places each note on the page its row lands on', () => {
    const t = createTable();
    for (let i = 0; i < 120; i++) t.addRow().addCell(i === 2 ? cited('r2', 'EARLY') : i === 110 ? cited('r110', 'LATE') : [{ text: `row ${i}` }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    expect(pageOf(pages, 'EARLY')).toBe(pageOf(pages, 'r2'));
    expect(pageOf(pages, 'LATE')).toBe(pageOf(pages, 'r110'));
    expect(pageOf(pages, 'LATE')).toBeGreaterThan(0);
  });

  it('a cited row and its note always share a page (property over filler sizes)', () => {
    for (let n = 70; n <= 110; n += 2) {
      const t = createTable();
      t.addRow().addCell(cited('CITEDROW', `THENOTE ${filler(4)}`));
      const flow = Document.New().NewFlow();
      flow.AddParagraph(filler(n));
      flow.AddTable(t);
      const pages = flow.Render();
      expect(pageOf(pages, 'THENOTE'), `filler ${n}`).toBe(pageOf(pages, 'CITEDROW'));
    }
  });

  it('a note in a repeating header row: mark on every page, note once (Review Focus 1)', () => {
    const t = createTable();
    t.addRow().addCell(cited('HEAD', 'HEADNOTE'));
    t.setRepeatingRowsCount(1);
    for (let i = 0; i < 120; i++) t.addRow().addCell([{ text: `row ${i}` }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.filter((p) => p.GetText().includes('HEADNOTE'))).toHaveLength(1);
    expect(pageOf(pages, 'HEADNOTE')).toBe(0);
    for (const p of pages) {
      const f = p.GetTextFragments();
      const head = f.find((x) => x.text.includes('HEAD') && !x.text.includes('HEADNOTE'))!;
      // the raised citation mark beside the header text, on every page
      expect(f.some((x) => x.text.trim() === '1' && x.fontSize < 8 && Math.abs(x.quad[1] - head.quad[1]) < 8)).toBe(true);
    }
  });

  it('a note in a later row of a multi-row header survives a split inside the header (final review #1)', () => {
    // fit() may cut between header rows; rows painted for the first time on the
    // continuation must still report their notes.
    for (let n = 100; n <= 125; n++) {
      const t = createTable();
      t.addRow().addCell([{ text: 'HEAD0' }]);
      t.addRow().addCell(cited('HEAD1', 'HDRNOTE'));
      t.setRepeatingRowsCount(2);
      for (let i = 0; i < 5; i++) t.addRow().addCell([{ text: `body ${i}` }]);
      const flow = Document.New().NewFlow();
      flow.AddParagraph(filler(n));
      flow.AddTable(t);
      const pages = flow.Render();
      expect(pages.filter((p) => p.GetText().includes('HDRNOTE')), `filler ${n}`).toHaveLength(1);
    }
  });

  it('rows added to the builder after AddTable render, cited or not (final review #2)', () => {
    const t = createTable();
    t.addRow().addCell(cited('first', 'NOTE1'));
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    t.addRow().addCell([{ text: 'LATEROW' }]);
    t.addRow().addCell(cited('later', 'NOTE2'));
    const text = flow.Render().map((p) => p.GetText()).join('\n');
    for (const s of ['LATEROW', 'NOTE1', 'NOTE2']) expect(text).toContain(s);
  });

  it('endnotes from a cell go after the content', () => {
    const t = createTable();
    t.addRow().addCell([{ text: 'x' }, { text: '', endnote: { content: 'ENDTEXT' } }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    flow.AddParagraph('closing');
    const f = flow.Render()[0].GetTextFragments();
    expect(f.find((x) => x.text.includes('ENDTEXT'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('closing'))!.quad[1]);
  });

  it("restart: 'page' numbers a split table's notes from 1 on each page", () => {
    const t = createTable();
    for (let i = 0; i < 120; i++) t.addRow().addCell(i % 30 === 0 ? cited(`c${i}`, `NT${i}`) : [{ text: `row ${i}` }]);
    const flow = Document.New().NewFlow({ footnotes: { restart: 'page' } });
    flow.AddTable(t);
    const pages = flow.Render();
    for (const p of pages) {
      const marks = [0, 30, 60, 90].map((i) => gutterOf(p, `NT${i}`)).filter((m) => m !== undefined).map(Number);
      expect(marks).toEqual(marks.map((_, k) => k + 1));
    }
  });

  it('a tagged note is a /Note under the cell’s /TD, and under /TH for a header cell', () => {
    const doc = Document.New();
    const t = createTable();
    t.addRow().addCell(cited('h', 'HN'), { header: true });
    t.addRow().addCell(cited('d', 'DN'));
    const flow = doc.NewFlow({ tagged: true });
    flow.AddTable(t);
    flow.Render();
    const notes = all(doc.GetStructTree()!).filter((e) => e.Type === 'Note');
    expect(notes.map((n) => n.Parent!.Type).sort()).toEqual(['TD', 'TH']);
  });

  it('an image after a cited run in a cell draws after the mark', async () => {
    const { makePng } = await import('./helpers/make-png.js');
    const t = createTable();
    t.addRow().addCell([{ text: 'AAA', ...fn('N') }, { text: ' BBB' }],
      { atomics: [{ beforeRun: 1, data: makePng(), width: 20, height: 10 }] });
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const f = flow.Render()[0].GetTextFragments();
    const aaa = f.find((x) => x.text.includes('AAA'))!;
    const mark = f.find((x) => x.text.trim() === '1' && x.fontSize < 8 && Math.abs(x.quad[1] - aaa.quad[1]) < 8)!;
    expect(mark.quad[0] - aaa.quad[0]).toBeLessThan(30);
  });

  it('the caller’s builder is untouched and page.AddTable still refuses it (Review Focus 4)', () => {
    const t: TableBuilder = createTable();
    t.addRow().addCell(cited('x', 'N'));
    const before = t.rows[0].cells[0].text;
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    flow.Render();
    expect(t.rows[0].cells[0].text).toBe(before);
    expect((before as unknown[]).length).toBe(2);
    const doc = Document.New();
    expect(() => doc.AddPage().page.AddTable(t, 72, 720, { width: 400 })).toThrow(/only inside a Flow/);
  });

  it('two table() calls over one builder lower two sets of references', () => {
    const t = createTable();
    t.addRow().addCell(cited('x', 'N'));
    const [a] = table(t);
    const [b] = table(t);
    expect(a.noteRefs!()).toHaveLength(1);
    expect(b.noteRefs!()[0]).not.toBe(a.noteRefs!()[0]);
  });

  it('mapCells keeps column specs, auto-fit and repeating rows', () => {
    const t = createTable();
    t.addRow(['a', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    t.addRow(['c', 'd']);
    t.setRepeatingRowsCount(1);
    t.autoFitColumns();
    const copy = t.mapCells(() => undefined);
    expect(copy.resolveColumnWidths(400)).toEqual(t.resolveColumnWidths(400));
    expect(copy.repeatingRowCount).toBe(1);
    expect(copy.rows[0].cells[0]).toBe(t.rows[0].cells[0]);
    const fixed = createTable();
    fixed.addRow(['a', 'b']);
    fixed.setColumnWidths([{ fixed: 100 }, { fraction: 1 }]);
    expect(fixed.mapCells(() => undefined).resolveColumnWidths(400)).toEqual([100, 300]);
  });
});
