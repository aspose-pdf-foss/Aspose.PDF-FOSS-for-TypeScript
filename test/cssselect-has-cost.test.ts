import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { collect, cascade } from '../src/csscascade.js';

/** ~`total` elements at a fixed nesting `depth`: a chain of `depth` divs, each
 *  padded with flat siblings until the budget is spent, with one `p.leaf` at
 *  the bottom so every div on the chain is a genuine `:has()` hit. */
function build(total: number, depth: number): string {
  const perLevel = Math.max(1, Math.floor(total / depth) - 1);
  let body = '<p class=leaf>x</p>';
  for (let d = 0; d < depth; d++) {
    body = `<div>${'<span>s</span>'.repeat(perLevel)}${body}</div>`;
  }
  return `<!doctype html><style>div:has(p.leaf){color:red}</style><body>${body}</body>`;
}

function run(total: number, depth: number): { divs: number; spans: number; ms: number } {
  const doc = parseHtml(build(total, depth));
  const c = collect(doc);
  const t = performance.now();
  const styled = cascade(doc, c);
  const ms = performance.now() - t;
  // By TAG, because the UA sheet declares `color` on <html> too — a bare
  // "has a color" count is 21 for a 20-deep chain and reads as an off-by-one.
  let divs = 0;
  let spans = 0;
  for (const [el, d] of styled) {
    if (!d.all.has('color')) continue;
    if (el.name === 'div') divs++;
    if (el.name === 'span') spans++;
  }
  return { divs, spans, ms };
}

/** The cost zch2.2.2 deferred this pseudo-class over, measured rather than
 *  reasoned about — and it is WORSE than the quadratic that issue predicted.
 *
 *  csscascade.ts asks every rule about every element; a `:has()` walks the
 *  anchor's subtree; and each candidate's own match then walks back UP the
 *  ancestor chain. So the driver is not the element count but the nesting
 *  DEPTH, and at a fixed 4,000 elements the measured times go
 *
 *    depth   10    20    40     80     160     320
 *    ms      31    38    63     187    703     2738
 *
 *  — roughly quadratic in depth from 40 on. An all-nested chain, where depth
 *  IS the element count, is therefore cubic: 250 divs cost 124 ms, 500 cost
 *  929, 1,000 cost 7.4 s and 2,000 cost 65 s.
 *
 *  Left UNGUARDED, deliberately. Real markup nests around 10-20 deep, where
 *  4,000 elements cost ~35 ms; depth in the hundreds is not a document
 *  anybody writes, nothing throws when it happens, and a visit budget would
 *  buy the bound by answering a selector WRONGLY on a large document. Recorded
 *  here so the number is a known limit rather than a later discovery. */
describe(':has() cost', () => {
  it('answers correctly on a document of a few thousand elements', () => {
    // The fence that matters: the walk must still be RIGHT at scale. Every
    // div on the chain holds the leaf, and no span does.
    const { divs, spans } = run(4000, 20);
    expect(divs).toBe(20);
    expect(spans).toBe(0);
  });

  it('stays far inside a second at a realistic nesting depth', () => {
    // Measured at ~35 ms. The bound is ~30x that, so this cannot fail on a
    // slow machine — it exists to catch an order-of-magnitude regression,
    // such as the candidate pool widening from the subtree to the document.
    const { ms } = run(4000, 20);
    expect(ms).toBeLessThan(1000);
  });

  it('costs nothing measurable when no rule uses :has()', () => {
    const doc = parseHtml(
      `<!doctype html><style>div{color:red}</style><body>${'<div><span>s</span></div>'.repeat(2000)}</body>`);
    const c = collect(doc);
    const t = performance.now();
    cascade(doc, c);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
