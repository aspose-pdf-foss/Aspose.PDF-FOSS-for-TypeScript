// test/flownotes-rebase.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { rebaseForMarks, citesNote } from '../src/flownotes.js';
import { makePng } from './helpers/make-png.js';

const atomic = (beforeRun: number) => ({ beforeRun, data: makePng(), width: 20, height: 10 });
const cited = [{ text: 'AAA', footnote: { content: 'NOTE' } }, { text: ' BBB' }];

/** The mark sits right after AAA: x of the small '1' fragment vs AAA's left. */
function markGap(pages: { GetTextFragments(): { text: string; fontSize: number; quad: number[] }[] }[]): number {
  const f = pages[0].GetTextFragments();
  const aaa = f.find((x) => x.text.includes('AAA'))!;
  const mark = f.find((x) => x.text.trim() === '1' && x.fontSize < 8 && Math.abs(x.quad[1] - aaa.quad[1]) < 8)!;
  return mark.quad[0] - aaa.quad[0];
}

describe('rebaseForMarks', () => {
  it('moves an atomic past every mark inserted before it', () => {
    const text = [{ text: 'a', footnote: { content: 'x' } }, { text: 'b' }, { text: 'c', endnote: { content: 'y' } }, { text: 'd' }];
    const out = rebaseForMarks(text, [{ beforeRun: 0 }, { beforeRun: 1 }, { beforeRun: 2 }, { beforeRun: 3 }, { beforeRun: 4 }]);
    // lowered: [a, m, b, c, m, d]
    expect(out!.map((a) => a.beforeRun)).toEqual([0, 2, 3, 5, 6]);
  });
  it('returns the atomics themselves when nothing is cited, and undefined for undefined', () => {
    const list = [{ beforeRun: 1 }];
    expect(rebaseForMarks([{ text: 'a' }, { text: 'b' }], list)).toBe(list);
    expect(rebaseForMarks('plain', list)).toBe(list);
    expect(rebaseForMarks(cited, undefined)).toBeUndefined();
  });
  it('citesNote', () => {
    expect(citesNote('x')).toBe(false);
    expect(citesNote([{ text: 'x' }])).toBe(false);
    expect(citesNote(cited)).toBe(true);
  });
});

describe('an image after a cited run draws AFTER the mark', () => {
  it('paragraph', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph(cited, { atomics: [atomic(1)] });
    expect(markGap(flow.Render())).toBeLessThan(30);   // AAA is 24pt wide; the bug put the image first (44)
  });
  it('heading', () => {
    const flow = Document.New().NewFlow();
    flow.AddHeading(3, cited, { fontSize: 12, atomics: [atomic(1)] });
    expect(markGap(flow.Render())).toBeLessThan(30);
  });
  it('list item', () => {
    const flow = Document.New().NewFlow();
    flow.AddList([{ text: cited, atomics: [atomic(1)] }]);
    expect(markGap(flow.Render())).toBeLessThan(30);
  });
});
