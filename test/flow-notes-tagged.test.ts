import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { FlowNote } from '../src/flow.js';
import { lookupNameTree } from '../src/nametree.js';
import type { StructElement } from '../src/struct.js';

const fn = (c: string): { footnote: FlowNote } => ({ footnote: { content: c } });
const en = (c: string): { endnote: FlowNote } => ({ endnote: { content: c } });
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function all(el: { Children: StructElement[] }): StructElement[] {
  return el.Children.flatMap((c) => [c, ...all(c)]);
}

describe('tagged notes', () => {
  it('a footnote is a /Note child of the referencing /P, with /Lbl and /P inside, and an /ID in /IDTree', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddParagraph([{ text: 'claim' }, { text: '', ...fn('The source.') }]);
    flow.Render();
    const root = doc.GetStructTree()!;
    const note = all(root).find((e) => e.Type === 'Note')!;
    expect(note.Parent!.Type).toBe('P');
    expect(note.Children.map((c) => c.Type)).toEqual(['P', 'Link']);   // the mark sits in a /Link (v9j3.3.4)
    expect(note.GetText()).toContain('1');                 // the mark is the /Note's own content
    expect(note.ID).toBe('fn-1');
    const hit = lookupNameTree(doc, root.Dict.get('IDTree') ?? null, 'fn-1');
    expect(hit).toEqual(note.Ref);
  });

  it('an endnote is tagged at its reference too', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddParagraph([{ text: 'x' }, { text: '', ...en('E') }]);
    flow.AddParagraph('after');
    flow.Render();
    const note = all(doc.GetStructTree()!).find((e) => e.Type === 'Note')!;
    expect(note.Parent!.Type).toBe('P');
    expect(note.ID).toBe('en-1');
  });

  it('a split note stays one /Note; ValidatePdfUa reports no UntaggedContent', () => {
    const doc = Document.New();
    doc.Lang = 'en';
    const flow = doc.NewFlow({ tagged: true, lang: 'en' });
    flow.AddParagraph([{ text: 'start' }, { text: '', ...fn(words(2500)) }, { text: ' and' }, { text: '', ...en('tail') }]);
    flow.Render();
    const notes = all(doc.GetStructTree()!).filter((e) => e.Type === 'Note');
    expect(notes).toHaveLength(2);
    const report = doc.ValidatePdfUa();
    expect(report.Issues.filter((i) => i.rule === 'UntaggedContent')).toEqual([]);
  });

  it('two tagged flows in one document never collide on /ID (Review Focus 2)', () => {
    const doc = Document.New();
    for (let k = 0; k < 2; k++) {
      const flow = doc.NewFlow({ tagged: true });
      flow.AddParagraph([{ text: `f${k}` }, { text: '', ...fn(`note ${k}`) }]);
      flow.Render();
    }
    const root = doc.GetStructTree()!;
    const ids = all(root).filter((e) => e.Type === 'Note').map((e) => e.ID);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(lookupNameTree(doc, root.Dict.get('IDTree') ?? null, id!)).toBeDefined();
  });

  it('an untagged flow writes no /Note and no /IDTree', () => {
    const doc = Document.New();
    doc.NewFlow().AddParagraph([{ text: 'x' }, { text: '', ...fn('n') }]).Render();
    expect(doc.GetStructTree()).toBeNull();
  });
});
