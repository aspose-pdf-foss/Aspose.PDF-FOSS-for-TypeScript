import { describe, it, expect } from 'vitest';
import { layoutRuns, layoutText, winAnsiDriver } from '../src/layout.js';
import type { FontDriver } from '../src/layout.js';
import { drawsNothing } from '../src/textcoverage.js';
import { Document } from '../src/document.js';

const CR = winAnsiDriver('Courier');
const SIZE = 12;
const LEADING = 14.4;

/** A driver that records what it was asked about. Counting through the DRIVER
 *  rather than a module mock, because `layoutRuns` takes one as an argument —
 *  so the cost is observable from outside with nothing stubbed. */
function counting(): { driver: FontDriver; measured: number[]; probed: number[] } {
  const measured: number[] = [];
  const probed: number[] = [];
  return {
    measured,
    probed,
    driver: {
      measure: (t, fs) => { measured.push(t.length); return CR.measure(t, fs); },
      encode: (t) => CR.encode(t),
      probe: (t) => { probed.push(t.length); return CR.probe(t); },
    },
  };
}

/** `n` distinct five-character words, so nothing can be memoized by value. */
function words(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(String(i).padStart(4, 'w'));
  return out.join(' ');
}

describe('layoutRuns measures only what the page holds (pl2h)', () => {
  it('does not wrap the text it is about to hand back as a remainder', () => {
    // Wrapping was eager — the whole text, then a prefix kept — so a page of a
    // long paragraph measured every word of the tail, TWICE (the over-wide
    // test and the greedy pack), and the tail was handed on and measured
    // again on the next page. Measured on 100,000 words before the fix: 11.1 M
    // characters through this function for 437 K of input, and 139,135 lines
    // wrapped to keep 5,470.
    const c = counting();
    const text = words(2000);
    const r = layoutRuns([{ text, driver: c.driver, fontSize: SIZE }],
      60, LEADING, LEADING, SIZE);
    // One line of 60pt at 7.2pt/char holds 8 characters — one word.
    expect(r.lines).toHaveLength(1);
    expect(r.remainder[0].text.length).toBeGreaterThan(9_000);
    // A handful of calls for the one line kept, against ~4,000 for the text.
    expect(c.measured.length).toBeLessThan(20);
    // And none of them looked at more than a line's worth of characters.
    expect(Math.max(...c.measured)).toBeLessThan(20);
  });

  it('costs the same for a long tail as for a short one', () => {
    // The sharper statement: the work is a function of what is PLACED, so
    // lengthening only the part that overflows must not change it at all.
    const short = counting();
    const long = counting();
    const rect = (d: FontDriver, text: string): void => {
      layoutRuns([{ text, driver: d, fontSize: SIZE }], 60, LEADING, LEADING, SIZE);
    };
    rect(short.driver, words(50));
    rect(long.driver, words(5000));
    expect(long.measured).toEqual(short.measured);
  });
});

describe('drawsNothing probes a prefix, not the whole text (pl2h)', () => {
  it('stops at the head when the text draws', () => {
    const c = counting();
    const text = words(5000);
    expect(drawsNothing(text, c.driver)).toBe(false);
    // `probe` ENCODES: asking about a megabyte allocates a megabyte, and a
    // paginated block asks once per page over the whole remainder.
    expect(Math.max(...c.probed)).toBeLessThanOrEqual(64);
  });

  it('still probes all of it when the head draws nothing, so the answer holds', () => {
    const c = counting();
    // 80 characters WinAnsi cannot encode, then one it can: the prefix draws
    // nothing, so the fast path must not answer.
    const text = `${'一'.repeat(80)}a`;
    expect(drawsNothing(text, c.driver)).toBe(false);
    expect(Math.max(...c.probed)).toBe(text.length);
  });

  it('answers true for a text no part of which draws', () => {
    expect(drawsNothing('一'.repeat(200), CR)).toBe(true);
  });
});

describe('a long paragraph paginates in time linear in its length (pl2h)', () => {
  it('doubling the text roughly doubles the work rather than quadrupling it', () => {
    // Before the fix each doubling cost 4x: 100,000 words took 26.4 s through
    // AddHtml and 6.2 s through AddMarkdown, and 400,000 did not finish in
    // two minutes. This is a RATIO rather than a time, so it cannot fail on a
    // slow machine; the quadratic it replaced gives ~4.
    const run = (n: number): number => {
      const text = `${words(n)} `;
      const doc = Document.New();
      const t = performance.now();
      doc.AddMarkdown(text);
      return performance.now() - t;
    };
    run(4000); // warm up, so the first measured run is not paying for the JIT
    const a = run(8000);
    const b = run(16_000);
    expect(b / a).toBeLessThan(3);
  });
});

describe('the remainder is re-flowed identically however it is cut', () => {
  it('a page-by-page walk yields exactly the lines one unbounded call does', () => {
    // The fence for the whole change: laziness must not move a single line.
    const text = 'one two three four five\nsecond paragraph here and a little more';
    const width = 80;
    const all = layoutText(text, CR, SIZE, width, 10_000, LEADING).lines.map((l) => l.text);
    const walked: string[] = [];
    let rest = text;
    while (rest !== '') {
      const r = layoutText(rest, CR, SIZE, width, LEADING, LEADING);
      expect(r.lines.length).toBe(1);
      walked.push(r.lines[0].text);
      rest = r.remainder;
    }
    expect(walked).toEqual(all);
  });
});
