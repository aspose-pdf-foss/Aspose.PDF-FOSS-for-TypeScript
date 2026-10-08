// test/flow-notes-restart.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { notesAsTrailing, normalizeNoteOptions, noteRestart, type NoteText } from '../src/flownotes.js';
import { paragraph } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';

/** Marks on a page — citation marks and gutter marks: small fragments that READ
 *  as a mark. The size test alone would also take the 8pt note bodies. */
const marks = (page: { GetTextFragments(): { text: string; fontSize: number }[] }, size: number) =>
  page.GetTextFragments().filter((f) => f.fontSize < size * 0.8 && f.fontSize > 0)
    .map((f) => f.text.trim()).filter((t) => /^(\d+|[ivxlc]+|\*)$/.test(t));

describe('flow.RestartNotes', () => {
  it('restarts footnote numbering at the marker', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'A' } }]);
    flow.AddParagraph([{ text: 'b' }, { text: '', footnote: { content: 'B' } }]);
    flow.RestartNotes('footnote');
    flow.AddParagraph([{ text: 'c' }, { text: '', footnote: { content: 'C' } }]);
    const [p] = flow.Render();
    // three citation marks + three gutter marks
    expect(marks(p, 12).sort()).toEqual(['1', '1', '1', '1', '2', '2']);
  });
  it('restarts only the kind named; no kind restarts both', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'A' } }, { text: ' x' }, { text: '', endnote: { content: 'E' } }]);
    flow.RestartNotes('endnote');
    flow.AddParagraph([{ text: 'b' }, { text: '', footnote: { content: 'B' } }, { text: ' y' }, { text: '', endnote: { content: 'F' } }]);
    const t = marks(flow.Render()[0], 12);
    expect(t.filter((m) => m === '2')).toHaveLength(2);       // footnote 2 continued (mark + gutter)
    expect(t.filter((m) => m === 'ii')).toHaveLength(0);      // endnotes restarted at i
    expect(t.filter((m) => m === 'i')).toHaveLength(4);
    const both = Document.New().NewFlow();
    both.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'A' } }]);
    both.RestartNotes();
    both.AddParagraph([{ text: 'b' }, { text: '', footnote: { content: 'B' } }]);
    expect(marks(both.Render()[0], 12).filter((m) => m === '2')).toHaveLength(0);
  });
  it('leaves no gap where the marker sits', () => {
    const render = (restart: boolean) => {
      const flow = Document.New().NewFlow();
      flow.AddParagraph('first');
      if (restart) flow.RestartNotes();
      flow.AddParagraph('second');
      const f = flow.Render()[0].GetTextFragments();
      return f.find((x) => x.text.includes('second'))!.quad[1];
    };
    expect(render(true)).toBeCloseTo(render(false), 6);
  });
  it('does not break keep-with-next: a heading before a marker stays with the next paragraph', () => {
    // 2190 words strand the heading at the page foot WITHOUT keep-with-next
    // (probed: 2170..2200 do; 1900, the first fixture, never did and measured
    // nothing). Note it CANNOT see the lookahead skipping the marker: asked
    // instead, the zero-height marker also advances the heading. The mid-page
    // case below is what separates the two.
    const flow = Document.New().NewFlow({ keepHeadingsWithNext: true });
    flow.AddParagraph('x '.repeat(2190));
    flow.AddHeading(2, 'KEPT');
    flow.RestartNotes();
    flow.AddParagraph('after the heading');
    const pages = flow.Render();
    const pageOf = (s: string) => pages.findIndex((p) => p.GetText().includes(s));
    expect(pageOf('KEPT')).toBe(pageOf('after the heading'));
    // control: the same flow without keep-with-next strands the heading
    const loose = Document.New().NewFlow({ keepHeadingsWithNext: false });
    loose.AddParagraph('x '.repeat(2190));
    loose.AddHeading(2, 'KEPT');
    loose.RestartNotes();
    loose.AddParagraph('after the heading');
    const lp = loose.Render();
    const lpageOf = (s: string) => lp.findIndex((p) => p.GetText().includes(s));
    expect(lpageOf('KEPT')).not.toBe(lpageOf('after the heading'));
  });
  it('a heading mid-page before a marker stays put: the zero-height marker is not its next', () => {
    // Asking the MARKER whether it fits answers usedHeight 0, which reads as
    // "the next line does not fit" and pushes the heading off a page it fits on.
    const flow = Document.New().NewFlow({ keepHeadingsWithNext: true });
    flow.AddParagraph('opening');
    flow.AddHeading(2, 'MIDHEAD');
    flow.RestartNotes();
    flow.AddParagraph('after the heading');
    const pages = flow.Render();
    expect(pages).toHaveLength(1);
    expect(pages[0].GetText()).toContain('MIDHEAD');
  });
  it('notesAsTrailing honours and strips restart elements', () => {
    const foot = normalizeNoteOptions(undefined, 'footnote');
    const end = normalizeNoteOptions(undefined, 'endnote');
    const mk = (t: NoteText, s: number) => paragraph(t, { fontSize: s });
    const els = [
      ...paragraph([{ text: 'a' }, { text: '', footnote: { content: 'A' } }]),
      noteRestart('footnote'),
      ...paragraph([{ text: 'b' }, { text: '', footnote: { content: 'B' } }]),
    ];
    const out = notesAsTrailing(els, foot, end, mk);
    expect(out.some((e) => (e as { noteRestart?: unknown }).noteRestart !== undefined)).toBe(false);
    const doc = Document.New();
    const page = doc.AddPage().page;
    placeElements(doc, page, out, [72, 72, 400, 700]);
    expect(marks(page, 12).filter((m) => m === '2')).toHaveLength(0);
  });
  it('placeElements skips a restart element', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const r = placeElements(doc, page, [...paragraph('one'), noteRestart(), ...paragraph('two')], [72, 72, 400, 700]);
    expect(r.remainder).toEqual([]);
    expect(page.GetText()).toContain('two');
  });
  it('RestartNotes refuses an unknown kind', () => {
    expect(() => Document.New().NewFlow().RestartNotes('sidenote' as never)).toThrow(TypeError);
  });
});
