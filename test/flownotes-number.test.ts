import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph } from '../src/flow.js';
import { lowerNotes, refsIn, normalizeNoteOptions, NoteNumberer, NoteElement } from '../src/flownotes.js';
import type { TextRun } from '../src/textdecor.js';

const mk = () => new NoteNumberer(
  normalizeNoteOptions(undefined, 'footnote'), normalizeNoteOptions(undefined, 'endnote'),
  (t, fontSize) => paragraph(t, { fontSize }));

function refsOf(runs: unknown[]) { return refsIn(lowerNotes(runs as TextRun[], 12)); }

describe('NoteNumberer', () => {
  it('numbers footnotes and endnotes in separate sequences, in order', () => {
    const n = mk();
    const [a, b, c] = refsOf([
      { text: 'a', footnote: { content: 'x' } }, { text: 'b', endnote: { content: 'y' } },
      { text: 'c', footnote: { content: 'z' } }]);
    for (const r of [a, b, c]) n.assign(r);
    expect([a.mark, b.mark, c.mark]).toEqual(['1', 'i', '2']);
    expect(n.any).toBe(true);
  });

  it('an explicit mark consumes no number', () => {
    const n = mk();
    const [a, b] = refsOf([{ text: 'a', footnote: { content: 'x', mark: '*' } }, { text: 'b', footnote: { content: 'y' } }]);
    n.assign(a); n.assign(b);
    expect([a.mark, b.mark]).toEqual(['*', '1']);
  });

  it('is idempotent per ref', () => {
    const n = mk();
    const [a, b] = refsOf([{ text: 'a', footnote: { content: 'x' } }, { text: 'b', footnote: { content: 'y' } }]);
    n.assign(a); n.assign(a); n.assign(b);
    expect(b.mark).toBe('2');
  });

  it('sizes and raises the mark run from the referencing run', () => {
    const n = mk();
    const [a] = refsIn(lowerNotes([{ text: 'a', fontSize: 10, footnote: { content: 'x' } }] as never, 12));
    n.assign(a);
    expect(a.markRun.text).toBe('1');
    expect(a.markRun.fontSize).toBeCloseTo(6, 9);
    expect(a.markRun.rise).toBeCloseTo(3.3, 9);
  });

  it('honours start and format', () => {
    const n = new NoteNumberer(normalizeNoteOptions({ start: 5, format: 'Alpha' }, 'footnote'),
      normalizeNoteOptions(undefined, 'endnote'), (t, s) => paragraph(t, { fontSize: s }));
    const [a] = refsOf([{ text: 'a', footnote: { content: 'x' } }]);
    n.assign(a);
    expect(a.mark).toBe('E');
  });

  it('builds a text body as NoteElements at the note font size; an element body wraps each element', () => {
    const n = mk();
    const els = [...paragraph('one'), ...paragraph('two')];
    const [a, b] = refsOf([{ text: 'a', footnote: { content: 'text body' } }, { text: 'b', footnote: { content: els } }]);
    n.assign(a); n.assign(b);
    expect(a.body.length).toBeGreaterThan(0);
    expect(a.body.every((e) => e instanceof NoteElement)).toBe(true);
    expect(b.body).toHaveLength(2);
    expect(b.body.every((e) => e instanceof NoteElement)).toBe(true);
  });
});

describe('NoteElement', () => {
  it('draws the mark once, in the gutter, and indents its body by the gutter', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const n = mk();
    const [a] = refsOf([{ text: 'a', footnote: { content: 'body text' } }]);
    n.assign(a);
    let top = 700;
    for (const el of a.body) {
      const r = el.place({ doc, page, x: 72, top, width: 300, availHeight: 200 });
      top -= r.usedHeight;
    }
    const frags = page.GetTextFragments();
    const mark = frags.find((f) => f.text === '1')!;
    const body = frags.find((f) => f.text.startsWith('body'))!;
    expect(mark.quad[0]).toBeCloseTo(72, 1);
    expect(body.quad[0]).toBeGreaterThan(mark.quad[2]);
    expect(frags.filter((f) => f.text === '1')).toHaveLength(1);
  });

  it('forwards measure to its child at the narrowed width', () => {
    const n = mk();
    const [a] = refsOf([{ text: 'a', footnote: { content: 'word '.repeat(60) } }]);
    n.assign(a);
    const el = a.body[0];
    const wide = el.measure!({ width: 400, availHeight: 1e6 }).usedHeight;
    const narrow = el.measure!({ width: 150, availHeight: 1e6 }).usedHeight;
    expect(narrow).toBeGreaterThan(wide);
  });

  it('a continuation draws no second mark', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const n = mk();
    const [a] = refsOf([{ text: 'a', footnote: { content: 'word '.repeat(200) } }]);
    n.assign(a);
    const r1 = a.body[0].place({ doc, page, x: 72, top: 700, width: 300, availHeight: 30 });
    expect(r1.remainder).not.toBeNull();
    r1.remainder!.place({ doc, page, x: 72, top: 400, width: 300, availHeight: 30 });
    expect(page.GetTextFragments().filter((f) => f.text === '1')).toHaveLength(1);
  });
});
