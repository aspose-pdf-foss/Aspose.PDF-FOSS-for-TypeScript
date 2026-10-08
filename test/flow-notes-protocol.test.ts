import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph, heading, list, quote } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { NoteNumberer, normalizeNoteOptions } from '../src/flownotes.js';

const fn = (t: string) => ({ footnote: { content: t } });
const words = (n: number) => 'word '.repeat(n);
function numberAll(els: { noteRefs?: () => unknown[] }[]) {
  const nb = new NoteNumberer(normalizeNoteOptions(undefined, 'footnote'),
    normalizeNoteOptions(undefined, 'endnote'), (t, s) => paragraph(t, { fontSize: s }));
  for (const e of els) for (const r of (e.noteRefs?.() ?? []) as never[]) nb.assign(r);
}

describe('noteRefs', () => {
  it('a paragraph reports its refs; a note-free paragraph reports none', () => {
    const [p] = paragraph([{ text: 'a', ...fn('x') }, { text: ' b', ...fn('y') }]);
    expect(p.noteRefs!().map((r) => r.note.content)).toEqual(['x', 'y']);
    expect(paragraph('plain')[0].noteRefs?.() ?? []).toEqual([]);
  });
  it('headings, list items, list blocks, quotes and indents forward', () => {
    expect(heading(2, [{ text: 'H', ...fn('h') }])[0].noteRefs!()).toHaveLength(1);
    const l = list([{ text: [{ text: 'item', ...fn('i') }], blocks: paragraph([{ text: 'blk', ...fn('b') }]) }]);
    expect(l.flatMap((e) => e.noteRefs?.() ?? [])).toHaveLength(2);
    expect(quote(paragraph([{ text: 'q', ...fn('q') }]))[0].noteRefs!()).toHaveLength(1);
    expect(paragraph([{ text: 'i', ...fn('i') }], { indent: { left: 10 } })[0].noteRefs!()).toHaveLength(1);
  });
});

describe('measure().notes', () => {
  it('reports only the refs in the content that would be kept', () => {
    const [p] = paragraph([{ text: words(10) }, { text: 'early', ...fn('e') }, { text: words(400) }, { text: 'late', ...fn('l') }]);
    numberAll([p]);
    const part = p.measure!({ width: 300, availHeight: 60 });
    expect(part.fits).toBe(false);
    expect(part.notes!.map((r) => r.note.content)).toEqual(['e']);
    const all = p.measure!({ width: 300, availHeight: 1e6 });
    expect(all.notes!.map((r) => r.note.content)).toEqual(['e', 'l']);
  });
  it('omits notes for a note-free element', () => {
    expect(paragraph('plain')[0].measure!({ width: 300, availHeight: 100 }).notes).toBeUndefined();
  });
});

describe('placeElements', () => {
  it('refuses an element carrying note references', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    expect(() => placeElements(doc, page, paragraph([{ text: 'a', ...fn('x') }]), [72, 72, 300, 600]))
      .toThrow(UnsupportedFeatureError);
  });
});

describe('a reference with empty text', () => {
  it('lowers to a bare mark that still reports its note', () => {
    const [p] = paragraph([{ text: '', ...fn('lonely') }]);
    numberAll([p]);
    expect(p.measure!({ width: 300, availHeight: 100 }).notes).toHaveLength(1);
    const doc = Document.New();
    const page = doc.AddPage().page;
    expect(p.place({ doc, page, x: 72, top: 700, width: 300, availHeight: 100 }).drew).toBe(true);
    expect(page.GetText()).toContain('1');
  });
});
