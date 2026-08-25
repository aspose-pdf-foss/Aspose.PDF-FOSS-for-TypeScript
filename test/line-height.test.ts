import { describe, it, expect } from 'vitest';
import { layoutRuns, winAnsiDriver } from '../src/layout.js';
import type { LayoutRun } from '../src/layout.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { measureTextBlock } from '../src/stamp.js';
import type { TextRun } from '../src/textdecor.js';

const d = winAnsiDriver('Helvetica');
const run = (text: string, fontSize: number): LayoutRun => ({ text, driver: d, fontSize });

describe('per-line height', () => {
  it('is the block leading when every run is at the block size', () => {
    const { lines } = layoutRuns([run('alpha beta gamma', 10)], 400, 400, 12, 10);
    expect(lines.length).toBe(1);
    expect(lines[0].height).toBe(12);
    expect(lines[0].maxFontSize).toBe(10);
  });

  it('scales the block ratio for a larger run', () => {
    // ratio = 12/10 = 1.2, so a 24pt run wants 28.8.
    const { lines } = layoutRuns([run('small ', 10), run('BIG', 24)], 400, 400, 12, 10);
    expect(lines.length).toBe(1);
    expect(lines[0].maxFontSize).toBe(24);
    expect(lines[0].height).toBeCloseTo(28.8, 9);
  });

  it('keeps the block leading when every run is SMALLER', () => {
    // The max is a floor: small runs must not tighten the line.
    //
    // Every run on the line has to be small for this to bite. A line mixing a
    // 10pt and a 4pt run has maxFontSize 10, so it yields `leading` with or
    // without the floor and cannot tell the two apart — measured, after that
    // exact fixture failed to go red when the Math.max was removed.
    const { lines } = layoutRuns([run('all ', 4), run('tiny', 4)], 400, 400, 12, 10);
    expect(lines[0].maxFontSize).toBe(4);
    expect(lines[0].height).toBe(12);       // not 4 * 12/10 = 4.8
  });

  it('preserves a double-spaced block ratio around the big run', () => {
    // ratio = 20/10 = 2, so a 24pt run wants 48 rather than 28.8.
    const { lines } = layoutRuns([run('small ', 10), run('BIG', 24)], 400, 400, 20, 10);
    expect(lines[0].height).toBeCloseTo(48, 9);
  });

  it('fits fewer lines in a fixed budget once one line is tall', () => {
    const words = 'alpha beta gamma delta epsilon zeta eta theta';
    // Narrow box, 4 lines' worth of height at the block leading.
    const flat = layoutRuns([run(words, 10)], 60, 48, 12, 10);
    const tall = layoutRuns([run('alpha ', 10), run('BETA', 24), run(` ${words}`, 10)],
      60, 48, 12, 10);
    expect(tall.lines.length).toBeLessThan(flat.lines.length);
    // And the kept lines' heights sum inside the budget.
    expect(tall.lines.reduce((n, l) => n + l.height, 0)).toBeLessThanOrEqual(48 + 1e-9);
  });

  it('uses the block size for a line with no runs on it', () => {
    // A blank paragraph line has no units to measure.
    const { lines } = layoutRuns([run('a\n\nb', 10)], 400, 400, 12, 10);
    expect(lines.every((l) => l.height === 12)).toBe(true);
  });
});

const RUNS: TextRun[] = [
  { text: 'ordinary body text that wraps onto a second line so there is something above ' },
  { text: 'HUGE', fontSize: 24 },
  { text: ' and then ordinary text continues after it for a while longer here' },
];

describe('an oversized run in a rendered block', () => {
  it('no longer overruns the line above it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(RUNS, [50, 400, 250, 300], { fontSize: 10, leading: 12 });
    const frags = page.GetTextFragments().sort((a, b) => b.quad[1] - a.quad[1]);
    const big = frags.find((f) => f.fontSize === 24)!;
    // Every fragment strictly above the big one must clear its top. Measured
    // before this change: the 24pt top was 702 against a baseline of 690 above.
    const above = frags.filter((f) => f.quad[1] > big.quad[1]);
    expect(above.length).toBeGreaterThan(0);
    for (const f of above) expect(big.quad[3]).toBeLessThanOrEqual(f.quad[1] + 1e-6);
  });

  it('keeps an oversized run on line 0 inside the block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const top = 400 + 300;      // rect [50, 400, 250, 300] -> top edge at 700
    page.AddTextBlock(
      [{ text: 'HUGE', fontSize: 24 }, { text: ' then ordinary text after it' }],
      [50, 400, 250, 300], { fontSize: 10, leading: 12 },
    );
    const big = page.GetTextFragments().find((f) => f.fontSize === 24)!;
    // Exactly at the top edge, not merely at-or-below it. A fragment's quad
    // runs baseline..baseline+size, and line 0's baseline is maxFontSize below
    // the band top — so the big glyphs meet the edge precisely.
    //
    // The loose `<=` form does not discriminate: dropping the baseline by the
    // line's HEIGHT instead of its maxFontSize (28.8 rather than 24) pushes the
    // whole block down to 695.2, which still satisfies an upper bound while
    // being wrong. Measured, after that exact mutation stayed green.
    expect(big.quad[3]).toBeCloseTo(top, 6);
  });

  it('reports a larger usedHeight for a block with an oversized run', () => {
    const flat = measureTextBlock(
      [{ text: 'alpha beta gamma' }] as TextRun[], 400, 400, { fontSize: 10, leading: 12 });
    const tall = measureTextBlock(
      [{ text: 'alpha ' }, { text: 'BETA', fontSize: 24 }, { text: ' gamma' }] as TextRun[],
      400, 400, { fontSize: 10, leading: 12 });
    expect(flat.usedHeight).toBeCloseTo(12, 9);
    expect(tall.usedHeight).toBeCloseTo(28.8, 9);
  });
});
