// test/flownotes-repeat.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph } from '../src/flow.js';
import { notesAsTrailing, normalizeNoteOptions, type NoteText } from '../src/flownotes.js';
import { placeElements } from '../src/flowplace.js';
import type { StructElement } from '../src/struct.js';

const pageOf = (pages: { GetText(): string }[], s: string) => pages.findIndex((p) => p.GetText().includes(s));
const count = (t: string, s: string) => t.split(s).length - 1;

describe('a repeated citation', () => {
  it('draws the same mark at every citation and the note once', () => {
    const note = { content: 'ONLYONCE' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: note }, { text: ' b' }, { text: '', footnote: note }]);
    flow.AddParagraph([{ text: 'c' }, { text: '', footnote: note }]);
    const [p] = flow.Render();
    expect(count(p.GetText(), 'ONLYONCE')).toBe(1);
    expect(p.GetTextFragments().filter((f) => f.text.trim() === '1').length).toBe(4);   // 3 marks + the gutter
  });
  it('places the note with its FIRST citation', () => {
    const note = { content: 'FIRSTPAGE' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: note }]);
    flow.AddColumnBreak();
    flow.AddParagraph([{ text: 'b' }, { text: '', footnote: note }]);
    const pages = flow.Render();
    expect(pageOf(pages, 'FIRSTPAGE')).toBe(0);
  });
  it('makes one /Note in a tagged flow', () => {
    const doc = Document.New();
    const note = { content: 'n' };
    const flow = doc.NewFlow({ tagged: true });
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: note }, { text: ' b' }, { text: '', footnote: note }]);
    flow.Render();
    const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
    expect(all(doc.GetStructTree()!).filter((e) => e.Type === 'Note')).toHaveLength(1);
  });
  it('a repeated endnote is listed once', () => {
    const note = { content: 'ENDONCE' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', endnote: note }, { text: ' b' }, { text: '', endnote: note }]);
    expect(count(flow.Render()[0].GetText(), 'ENDONCE')).toBe(1);
  });
});

describe('notesAsTrailing', () => {
  const foot = normalizeNoteOptions(undefined, 'footnote');
  const end = normalizeNoteOptions(undefined, 'endnote');
  const mk = (t: NoteText, s: number) => paragraph(t, { fontSize: s });
  it('numbers, detaches, and appends the notes after the content', () => {
    const els = paragraph([{ text: 'body' }, { text: '', footnote: { content: 'TRAIL' } }]);
    const out = notesAsTrailing(els, foot, end, mk);
    expect(out.length).toBeGreaterThan(els.length);
    expect(out.flatMap((e) => e.noteRefs?.() ?? [])).toEqual([]);
    const doc = Document.New();
    const page = doc.AddPage().page;
    placeElements(doc, page, out, [72, 72, 400, 700]);
    const f = page.GetTextFragments();
    expect(f.find((x) => x.text.includes('TRAIL'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('body'))!.quad[1]);
  });
  it('returns the elements unchanged when nothing cites a note', () => {
    const els = paragraph('plain');
    expect(notesAsTrailing(els, foot, end, mk)).toBe(els);
  });
  it('lists footnotes before endnotes, a repeat once', () => {
    const n = { content: 'FN' };
    const els = paragraph([{ text: 'x' }, { text: '', endnote: { content: 'EN' } }, { text: '', footnote: n }, { text: '', footnote: n }]);
    const doc = Document.New();
    const page = doc.AddPage().page;
    placeElements(doc, page, notesAsTrailing(els, foot, end, mk), [72, 72, 400, 700]);
    const t = page.GetText();
    expect(t.indexOf('FN')).toBeLessThan(t.indexOf('EN'));
    expect(count(t, 'FN')).toBe(1);
  });
});
