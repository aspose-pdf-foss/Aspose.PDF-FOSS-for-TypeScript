import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { FlowNote } from '../src/flow.js';
import { paragraph, list } from '../src/flow.js';

const en = (content: FlowNote['content']): { endnote: FlowNote } => ({ endnote: { content } });
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('endnotes', () => {
  it('follow the content, in reference order, with roman marks', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'first' }, { text: '', ...en('END-A') }]);
    flow.AddParagraph([{ text: 'second' }, { text: '', ...en('END-B') }]);
    flow.AddParagraph('closing paragraph');
    const [p] = flow.Render();
    const f = p.GetTextFragments();
    const y = (s: string) => f.find((x) => x.text.includes(s))!.quad[1];
    expect(y('END-A')).toBeLessThan(y('closing'));
    expect(y('END-B')).toBeLessThan(y('END-A'));
    expect(f.some((x) => x.text === 'ii')).toBe(true);
  });

  it('newPage starts them on a fresh page', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ endnotes: { newPage: true } });
    flow.AddParagraph([{ text: 'body' }, { text: '', ...en('END') }]);
    const pages = flow.Render();
    expect(pages).toHaveLength(2);
    expect(pages[1].GetText()).toContain('END');
    expect(pages[0].GetText()).not.toContain('END');
  });

  it('newPage in a two-column flow is a PAGE break, not a column break', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ columns: 2, endnotes: { newPage: true } });
    flow.AddParagraph([{ text: 'body' }, { text: '', ...en('END') }]);
    const pages = flow.Render();
    expect(pages).toHaveLength(2);
    expect(pages[0].GetText()).not.toContain('END');
    expect(pages[1].GetText()).toContain('END');
  });

  it('paginate like content when long', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'x' }, { text: '', ...en(words(2000)) }]);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[pages.length - 1].GetText()).toContain('w1999');
  });

  it('accept an element body (a list inside a note)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'x' }, { text: '', ...en([...paragraph('intro'), ...list(['alpha', 'beta'])]) }]);
    const t = flow.Render()[0].GetText();
    expect(t).toContain('alpha');
    expect(t).toContain('beta');
  });

  it('coexist with footnotes', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'x' }, { text: '', footnote: { content: 'FOOT' } },
      { text: ' y' }, { text: '', ...en('ENDN') }]);
    const t = flow.Render()[0].GetText();
    expect(t).toContain('FOOT');
    expect(t).toContain('ENDN');
  });
});
