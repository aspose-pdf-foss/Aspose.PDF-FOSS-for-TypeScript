import { describe, it, expect, vi } from 'vitest';
import { layoutRuns, winAnsiDriver } from '../src/layout.js';

/** `lqs1` made an over-wide word's SPLIT lazy and its over-wide TEST a growing
 *  probe, so neither runs past the page any more — `markdown-pathological-cost`
 *  holds those, and they are linear in the PAGE. What it left was linear in the
 *  WORD: the UAX #14 analysis that precedes both still ran over the whole
 *  remaining word on every page it spanned, so a word of L characters over P
 *  pages cost O(P*L). Measured on `'[a]('.repeat(n) + 'x'` through `AddMarkdown`
 *  before the fix: 176/360/817/2322/7491 ms at 50k/100k/200k/400k/800k
 *  characters, ratios climbing toward 4, and 41 s at 2,000,000 (`lt63`).
 *
 *  Counted through a MODULE MOCK rather than a driver, because unlike `measure`
 *  the analyser is not an argument to `layoutRuns` — `layout.ts` holds it as a
 *  direct ESM import binding. `drprune-parse-once.test.ts`'s arrangement. */
const analysed = vi.hoisted(() => ({ codePoints: 0 }));
vi.mock('../src/linebreak.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/linebreak.js')>();
  return {
    ...actual,
    // Both entry points are counted, so the count is comparable across the
    // change: `layout.ts` called the first before `lt63` and the second after.
    // `lineBreakPrefix` reaches its own module-local `lineBreakOpportunities`
    // rather than this binding, so nothing is counted twice.
    lineBreakOpportunities: (codes: number[]) => {
      analysed.codePoints += codes.length;
      return actual.lineBreakOpportunities(codes);
    },
    lineBreakPrefix: (codes: number[], whole: boolean) => {
      analysed.codePoints += codes.length;
      return actual.lineBreakPrefix(codes, whole);
    },
  };
});

const CR = winAnsiDriver('Courier');
const SIZE = 12;
const LEADING = 14.4;

/** Paginate one over-wide word to exhaustion, the way `flow.ts` does, and
 *  report how many code points reached the line-break analyser. */
function analysedFor(word: string): number {
  analysed.codePoints = 0;
  let text = word;
  for (let page = 0; text.length > 0 && page < 20_000; page++) {
    const r = layoutRuns([{ text, driver: CR, fontSize: SIZE }],
      60, LEADING * 5, LEADING, SIZE);
    if (r.lines.length === 0) break;
    text = r.remainder.map((x) => x.text).join('');
  }
  return analysed.codePoints;
}

describe('a page-long word is not line-break-analysed in full on every page (lt63)', () => {
  it('analyses a number of code points that grows with the word, not with word x pages', () => {
    // Doubling the word must not more than double the analysis. The eager build
    // lands at 4x, since it re-analyses the whole remaining word once per page.
    const small = analysedFor('[a]('.repeat(500));
    const large = analysedFor('[a]('.repeat(1_000));
    expect(large).toBeLessThan(small * 3);
  });

  it('does not stall on a word whose numeric runs straddle the analysed prefix', () => {
    // The horizon is `n - 1` whatever the text, but a rule that backed off to
    // the start of a truncated LB25 scan would stall here instead — every cut
    // lands inside a numeric run. Measured as a separate input for that reason.
    const small = analysedFor('$1,234.00-and-5/6-'.repeat(500));
    const large = analysedFor('$1,234.00-and-5/6-'.repeat(1_000));
    expect(large).toBeLessThan(small * 3);
  });

  it('analyses each page a bounded multiple of the characters it keeps', () => {
    // The probe doubles, so the prefix is at most twice what the page consumed
    // and the whole word costs a small multiple of its own length across every
    // page. An absolute bound rather than a ratio, so a build that is linear
    // with an enormous constant is still caught.
    const word = '[a]('.repeat(2_000); // 8,000 characters
    expect(analysedFor(word)).toBeLessThan(8 * word.length);
  });
});
