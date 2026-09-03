import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { flowTextBlock, measureTextBlock } from '../src/stamp.js';
import { buildImageXObject } from '../src/imageembed.js';
import type { Page } from '../src/page.js';

/** A 1x1 red PNG — the smallest thing buildImageXObject accepts. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const content = (page: Page): string =>
  new TextDecoder('latin1').decode(page.Contents);

function draw(atomicAt: number, width = 20, height = 20) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const built = buildImageXObject(new Uint8Array(PNG_1x1));
  flowTextBlock(doc, page, [{ text: 'before ' }, { text: 'after' }],
    [20, 400, 400, 300], {
      fontSize: 12,
      atomics: [{ beforeRun: atomicAt, built, width, height, align: 'baseline' }],
    });
  return { doc, page };
}

describe('an atomic in a stamped run block', () => {
  it('advances the pen with a TJ kern', () => {
    // buildRunBlockBody emits NO per-segment Td — its own comment says "Tj
    // advances the pen by the string's own width". An atomic emits no Tj, so
    // without an explicit kern the text after the image overprints it.
    expect(content(draw(1).page)).toMatch(/\[\s*-?\d+(\.\d+)?\s*\]\s*TJ/);
  });

  it('puts the text after the image further right than without it', () => {
    // The kern is only correct if it MOVES something: this is the assertion a
    // malformed-but-present TJ cannot satisfy.
    const withBox = draw(1).page.GetTextFragments()
      .find((f) => f.text.includes('after'))!;
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    flowTextBlock(doc, page, [{ text: 'before ' }, { text: 'after' }],
      [20, 400, 400, 300], { fontSize: 12 });
    const without = page.GetTextFragments().find((f) => f.text.includes('after'))!;
    expect(withBox.quad[0]).toBeGreaterThan(without.quad[0] + 19);
  });

  it('draws both words either side of the image', () => {
    const t = draw(1).page.GetText();
    expect(t).toContain('before');
    expect(t).toContain('after');
  });

  it('measures a block the same way it paints it', () => {
    // measureTextBlock and flowTextBlock share resolveRuns and layoutRuns, so
    // an atomic must reach BOTH or a paragraph measures one way and paints
    // another — the failure the one-wrapping-engine rule exists to prevent.
    // A 200pt-wide box in a 100pt column forces a wrap, so a measure that
    // ignored the atomic would report ONE line's height where two are drawn.
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    const opts = {
      fontSize: 12,
      atomics: [{ beforeRun: 1, built, width: 200, height: 20,
        align: 'baseline' as const }],
    };
    const runs = [{ text: 'before ' }, { text: 'after' }];
    const measured = measureTextBlock(runs, 100, 300, opts).usedHeight;

    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const drawn = flowTextBlock(doc, page, runs, [20, 100, 100, 300], opts).usedHeight;
    expect(measured).toBe(drawn);
  });
});

describe('the image itself', () => {
  it('registers an XObject and draws it', () => {
    expect(content(draw(1).page)).toMatch(/\/Im\d+ Do/);
  });

  it('places it where the layout put it, on the text baseline', () => {
    // The box's BOTTOM sits on the baseline for align: baseline, so its cm
    // translate must equal the baseline of the line it is on.
    const { page } = draw(1);
    const before = page.GetTextFragments().find((f) => f.text.includes('before'))!;
    const m = /20 0 0 20 ([\d.-]+) ([\d.-]+) cm/.exec(content(page));
    expect(m, `no 20x20 cm in ${content(page).slice(0, 400)}`).not.toBeNull();
    expect(Number(m![2])).toBeCloseTo(before.quad[1], 1);
  });

  it('draws nothing for a zero-area atomic', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    flowTextBlock(doc, page, [{ text: 'a' }], [20, 400, 400, 300], {
      fontSize: 12,
      atomics: [{ beforeRun: 1, built, width: 0, height: 0, align: 'baseline' }],
    });
    expect(content(page)).not.toMatch(/ Do/);
  });

  it('draws an over-wide image at its CLAMPED size', () => {
    // layoutRuns clamps an atomic wider than the box, so the drawn rect must
    // come from the SEGMENT rather than from the caller's BlockAtomic. Reading
    // the original leaves the picture overflowing the column at its full
    // width while the layout has already reserved the clamped band for it.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    flowTextBlock(doc, page, [{ text: 'a' }], [20, 400, 100, 300], {
      fontSize: 12,
      atomics: [{ beforeRun: 1, built, width: 400, height: 200, align: 'baseline' }],
    });
    // 400x200 clamped to a 100pt box is 100x50.
    expect(content(page)).toMatch(/100 0 0 50 /);
    expect(content(page)).not.toMatch(/400 0 0 200 /);
  });

  it('puts a TOP-aligned box above a BASELINE-aligned one', () => {
    // The band arithmetic reaching the ink: `top` hangs from the band top,
    // `baseline` sits on the baseline, so the first is strictly higher for a
    // box shorter than the band.
    const y = (align: 'baseline' | 'top') => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      const built = buildImageXObject(new Uint8Array(PNG_1x1));
      flowTextBlock(doc, page, [{ text: 'before ' }, { text: 'after' }],
        [20, 400, 400, 300], {
          fontSize: 12, leading: 40,
          atomics: [{ beforeRun: 1, built, width: 8, height: 8, align }],
        });
      return Number(/8 0 0 8 [\d.-]+ ([\d.-]+) cm/.exec(content(page))![1]);
    };
    expect(y('top')).toBeGreaterThan(y('baseline'));
  });
});

describe('an atomic at a column break', () => {
  it('re-bases beforeRun onto the sliced run list', () => {
    // THE TRAP. layoutRuns returns RunSlice[] and stamp.ts rebuilds a FRESH
    // TextRun[] via sliceContent — it does not re-flow against the same array.
    // An atomic in the overflow whose beforeRun was not re-based lands at the
    // wrong place, or off the end and vanishes. A test that only inspects the
    // FIRST column cannot see this.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    // The fixture has to be built with care, and the first two attempts were
    // NOT discriminating. Run 0 must be FULLY CONSUMED in column one, so the
    // remainder's run list is SHORTER than the original and the re-based
    // index genuinely differs. With any of run 0 surviving, the original
    // index and the re-based one coincide and the mutation passes.
    //
    // 'aaaa ' fits the 60pt line; the 55pt box cannot join it, so it wraps to
    // line two, which the 16pt height excludes.
    const res = flowTextBlock(doc, page,
      [{ text: 'aaaa ' }, { text: 'eeee' }],
      [20, 400, 60, 16], {
        fontSize: 12,
        atomics: [{ beforeRun: 1, built, width: 55, height: 10, align: 'baseline' }],
      });
    expect(res.remainder).not.toBeNull();
    expect(res.remainderAtomics).toBeDefined();
    expect(res.remainderAtomics!).toHaveLength(1);
    // The remainder is ONE run ('eeee'), and the atomic precedes it — so the
    // re-based index is 0 where the original was 1.
    //
    // Asserted EXACTLY, and measured: `toBeLessThanOrEqual(remainder.length)`
    // is satisfied by the un-rebased index too, so a mutation that carries
    // beforeRun forward unchanged reddens NOTHING against it. The whole trap
    // this case exists for slips through a bound.
    expect(res.remainder!).toHaveLength(1);
    expect(res.remainderAtomics![0].beforeRun).toBe(0);
  });

  it('reports no remainder atomics when everything fit', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    const res = flowTextBlock(doc, page, [{ text: 'a ' }, { text: 'b' }],
      [20, 400, 400, 300], {
        fontSize: 12,
        atomics: [{ beforeRun: 1, built, width: 10, height: 10, align: 'baseline' }],
      });
    expect(res.remainder).toBeNull();
  });

  it('draws the image once in the SECOND column, not the first', () => {
    // The end of the trap: the continuation must actually paint it.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    const opts = {
      fontSize: 12,
      atomics: [{ beforeRun: 1, built, width: 10, height: 10,
        align: 'baseline' as const }],
    };
    const first = flowTextBlock(doc, page,
      [{ text: 'aaaa bbbb cccc dddd ' }, { text: 'eeee' }],
      [20, 400, 60, 14], opts);
    expect(content(page)).not.toMatch(/ Do/);      // not in column one
    flowTextBlock(doc, page, first.remainder!, [200, 400, 60, 300],
      { ...opts, atomics: first.remainderAtomics });
    expect(content(page)).toMatch(/ Do/);          // drawn in column two
  });
});
