/** Regressions from the v9j3.3 whole-branch review. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { formatMark } from '../src/flownotes.js';
import { encodeWinAnsi } from '../src/encoding.js';
import type { FlowNote } from '../src/flow.js';

const words = (n: number, p = 'w') => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');
const fn = (content: FlowNote['content']): { footnote: FlowNote } => ({ footnote: { content } });
const pageOf = (pages: { GetText(): string }[], s: string) => pages.findIndex((p) => p.GetText().includes(s));

describe('review #6: the same runs may be built again', () => {
  it('a second document built from the same data does not throw', () => {
    const runs = [{ text: 'a' }, { text: '', footnote: { content: 'n' } }];
    Document.New().NewFlow().AddParagraph(runs).Render();
    expect(() => Document.New().NewFlow().AddParagraph(runs).Render()).not.toThrow();
  });
  it('one FlowNote cited twice in ONE flow renders the note once (v9j3.3.1)', () => {
    const note = { content: 'NOTEONCE' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a', footnote: note }]);
    flow.AddParagraph([{ text: 'b', footnote: note }]);
    expect(flow.Render()[0].GetText().split('NOTEONCE')).toHaveLength(2);
  });
});

describe('review #7: an undefined footnote key is no footnote', () => {
  it('renders inside a Flow', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a', footnote: undefined }]);
    expect(() => flow.Render()).not.toThrow();
  });
  it('and outside one', () => {
    const page = Document.New().AddPage().page;
    expect(() => page.AddTextBlock([{ text: 'a', footnote: undefined } as never], [72, 72, 300, 300])).not.toThrow();
  });
});

describe('review #8: every symbols mark is drawable in a Standard-14 face', () => {
  it('the first twelve marks encode in WinAnsi', () => {
    for (let n = 1; n <= 12; n++) { const m = formatMark(n, 'symbols'); expect(encodeWinAnsi(m).length).toBe(m.length); }
  });
});

describe('review #2: notes add no PDF/UA errors', () => {
  const errors = (withNotes: boolean) => {
    const doc = Document.New();
    doc.Lang = 'en';
    const flow = doc.NewFlow({ tagged: true, lang: 'en' });
    flow.AddParagraph(withNotes
      ? [{ text: 'a' }, { text: '', ...fn('one') }, { text: ' b' }, { text: '', endnote: { content: 'two' } }]
      : [{ text: 'a b' }]);
    flow.Render();
    return doc.ValidatePdfUa().Errors.map((e) => e.rule).sort();
  };
  it('a tagged flow with notes reports exactly the errors the same flow without them does', () => {
    expect(errors(true)).toEqual(errors(false));
  });
});

describe('review #1: a sliver left by carry never drops a note', () => {
  it.each([4020, 4036, 4052, 5316, 5348])('note of %i words, then a cited paragraph', (n) => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'Start' }, { text: '', ...fn(words(n, 'n')) }]);
    flow.AddParagraph([{ text: words(400, 'b') + ' REF2' }, { text: '', ...fn('NOTETWO zz') }]);
    const pages = flow.Render();
    expect(pageOf(pages, 'NOTETWO')).toBeGreaterThanOrEqual(0);
    expect(pageOf(pages, 'NOTETWO')).toBe(pageOf(pages, 'REF2'));
  });
});

describe('review #3: keep-with-next counts the next paragraph’s OWN footnote', () => {
  it.each([612, 624, 636, 648])('filler %i: the heading never stays alone', (w) => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph(words(w));
    flow.AddHeading(2, 'KEPT');
    flow.AddParagraph([{ text: 'BODYFIRST' }, { text: '', ...fn(words(120, 'n')) }, { text: ' more' }]);
    const pages = flow.Render();
    expect(pageOf(pages, 'KEPT')).toBe(pageOf(pages, 'BODYFIRST'));
  });
});

describe('review #4: the footnote area never overprints a float', () => {
  it.each([220, 235, 250])('float of %i words beside a cited paragraph', (f) => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph(words(40));
    const box = doc.NewFloatingBox({ width: 150 });
    box.AddParagraph(words(f, 'f'));
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph([{ text: 'REF' }, { text: '', ...fn(words(300, 'n')) }, { text: ' ' + words(200, 'b') }]);
    for (const p of flow.Render()) {
      const fr = p.GetTextFragments();
      const floatYs = fr.filter((x) => /^f\d/.test(x.text)).map((x) => x.quad[1]);
      const noteTops = fr.filter((x) => /^n\d/.test(x.text)).map((x) => x.quad[3]);
      if (floatYs.length === 0 || noteTops.length === 0) continue;
      expect(Math.min(...floatYs)).toBeGreaterThan(Math.max(...noteTops));
    }
  });
});

describe('review #5: lines above a moved reference fill the page', () => {
  it('page 1 is filled down to the reference line, not stopped short', () => {
    const r = 660;
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: words(r) }, { text: '', ...fn(words(400, 'n')) }, { text: ' ' + words(900, 'b') }]);
    const pages = flow.Render();
    const body = pages[0].GetTextFragments().filter((x) => /^w\d/.test(x.text)).map((x) => x.quad[1]);
    expect(Math.min(...body)).toBeLessThan(180);
    expect(pageOf(pages, 'n0 ')).toBe(pageOf(pages, `w${r - 1}`));
  });
});

describe('review #1b: a reference in content drawn past the column bottom still gets its note', () => {
  it('a line taller than the column, citing a footnote', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'X', fontSize: 900 }, { text: '', ...fn('BIGNOTE') }]);
    const pages = flow.Render();
    expect(pageOf(pages, 'BIGNOTE')).toBeGreaterThanOrEqual(0);
  });
});
