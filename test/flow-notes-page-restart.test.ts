// test/flow-notes-page-restart.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { normalizeNoteOptions } from '../src/flownotes.js';

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Body sentence ${i} fills the page steadily.`).join(' ');
/** Small fragments (marks) on a page, with their y. */
const smalls = (page: { GetTextFragments(): { text: string; fontSize: number; quad: number[] }[] }) =>
  page.GetTextFragments().filter((f) => f.fontSize < 8).map((f) => ({ t: f.text.trim(), y: f.quad[1] }));

describe("footnotes.restart: 'page'", () => {
  const build = (restart: 'page' | 'continuous') => {
    const flow = Document.New().NewFlow({ footnotes: { restart } });
    for (let i = 0; i < 8; i++)
      flow.AddParagraph([{ text: filler(14) }, { text: '', footnote: { content: `NOTE${i}` } }]);
    return flow.Render();
  };
  it('numbers from 1 on every page', () => {
    const pages = build('page');
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      const nums = smalls(p).map((s) => s.t).filter((t) => /^\d+$/.test(t)).map(Number);
      if (nums.length === 0) continue;
      expect(Math.min(...nums)).toBe(1);
    }
  });
  it('numbers 1, 2, … in order on a page holding several notes', () => {
    // `min === 1` alone passes when every note on a page is 1, which is what a
    // build that stops counting committed references draws.
    let multi = 0;
    for (const p of build('page')) {
      const f = p.GetTextFragments();
      const gutters: number[] = [];
      for (let i = 0; i < 8; i++) {
        const body = f.find((x) => x.text.includes(`NOTE${i}`));
        if (body === undefined) continue;
        const g = f.find((x) => x.fontSize < 8 && Math.abs(x.quad[1] - body.quad[1]) < 4 && x.quad[0] < body.quad[0])!;
        gutters.push(Number(g.text.trim()));
      }
      expect(gutters).toEqual(gutters.map((_, k) => k + 1));
      if (gutters.length > 1) multi++;
    }
    expect(multi).toBeGreaterThan(0);
  });
  it('a renumbered note keeps the gutter of its NEW mark', () => {
    // Twelve notes on page 1, so the note on page 2 was first numbered 13 and
    // is renumbered 1: its body must start where page 1's note 1 does, not
    // where a two-digit gutter would put it.
    const flow = Document.New().NewFlow({ footnotes: { restart: 'page' } });
    for (let i = 0; i < 12; i++) flow.AddParagraph([{ text: `line ${i}` }, { text: '', footnote: { content: `NOTE${i}` } }]);
    flow.AddParagraph(filler(80));
    flow.AddParagraph([{ text: 'late' }, { text: '', footnote: { content: 'LATENOTE' } }]);
    const pages = flow.Render();
    const xOf = (s: string) => {
      for (const p of pages) {
        const b = p.GetTextFragments().find((x) => x.text.includes(s));
        if (b) return { page: pages.indexOf(p), x: b.quad[0] };
      }
      throw new Error(s);
    };
    const first = xOf('NOTE0');
    const late = xOf('LATENOTE');
    expect(late.page).toBeGreaterThan(first.page);
    expect(late.x).toBeCloseTo(first.x, 6);
  });
  it('continuous numbering is unchanged (control)', () => {
    const pages = build('continuous');
    const last = pages[pages.length - 1];
    const nums = smalls(last).map((s) => s.t).filter((t) => /^\d+$/.test(t)).map(Number);
    expect(Math.min(...nums)).toBeGreaterThan(1);
  });
  it('a citation mark always equals its gutter mark', () => {
    for (const p of build('page')) {
      const t = p.GetText();
      for (let i = 0; i < 8; i++) {
        if (!t.includes(`NOTE${i}`)) continue;
        // the gutter mark sits on the note's own line, just left of it
        const f = p.GetTextFragments();
        const body = f.find((x) => x.text.includes(`NOTE${i}`))!;
        const gutter = f.filter((x) => x.fontSize < 8 && Math.abs(x.quad[1] - body.quad[1]) < 4 && x.quad[0] < body.quad[0]);
        expect(gutter).toHaveLength(1);
        const mark = gutter[0].text.trim();
        // the same number appears as a raised citation mark above the foot
        const citations = f.filter((x) => x.fontSize < 8 && x.text.trim() === mark && x.quad[1] > body.quad[1] + 20);
        expect(citations.length).toBeGreaterThan(0);
      }
    }
  });
  it('a line pushed to the next page is renumbered there (Review Focus 2)', () => {
    // One page nearly full, then a citation whose line cannot fit with its note.
    const flow = Document.New().NewFlow({ footnotes: { restart: 'page' } });
    flow.AddParagraph([{ text: filler(88) }, { text: '', footnote: { content: 'FIRSTPAGE' } }]);
    flow.AddParagraph([{ text: filler(4) }, { text: '', footnote: { content: 'MOVED ' + filler(6) } }]);
    const pages = flow.Render();
    const pageOf = (s: string) => pages.findIndex((p) => p.GetText().includes(s));
    const moved = pageOf('MOVED');
    expect(moved).toBe(pageOf('FIRSTPAGE') + 1);
    const f = pages[moved].GetTextFragments();
    const body = f.find((x) => x.text.includes('MOVED'))!;
    const gutter = f.find((x) => x.fontSize < 8 && Math.abs(x.quad[1] - body.quad[1]) < 4 && x.quad[0] < body.quad[0])!;
    expect(gutter.text.trim()).toBe('1');
  });
  it('endnotes refuse restart: page', () => {
    expect(() => normalizeNoteOptions({ restart: 'page' } as never, 'endnote')).toThrow(TypeError);
    expect(() => normalizeNoteOptions({ restart: 'sometimes' } as never, 'footnote')).toThrow(TypeError);
    expect(normalizeNoteOptions(undefined, 'footnote').restart).toBe('continuous');
  });
});
