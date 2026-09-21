import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { lowerHtml } from '../src/cssflow.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

/** Counts `resolveBoxes` calls. A module mock rather than a spy, since both
 *  `cssmargin.ts` and `cssflow.ts` hold the function as a direct ESM import
 *  binding — drprune-parse-once.test.ts's arrangement, for its reason. */
const resolves = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/cssresolve.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/cssresolve.js')>();
  return {
    ...actual,
    resolveBoxes: (...args: Parameters<typeof actual.resolveBoxes>) => {
      resolves.count++;
      return actual.resolveBoxes(...args);
    },
  };
});

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;

/** A SINGLE-CHILD chain, which is the shape that separates the two readings:
 *  there the first in-flow child and the last in-flow child are the SAME box,
 *  so a walk computing both escaped edges together makes two recursive calls
 *  per level for one answer — 2^depth over the chain. A chain whose levels
 *  held two children each would still double, just less visibly. */
function chain(depth: number): string {
  return `<!doctype html>${'<div>'.repeat(depth)}<p>hello</p>${'</div>'.repeat(depth)}`;
}

function build(depth: number): number {
  resolves.count = 0;
  const { elements } = lowerHtml(parseHtml(chain(depth)), { width: 600, resolveFamily });
  // The fixture must actually produce the paragraph, or it measures nothing.
  expect(elements).toHaveLength(1);
  return resolves.count;
}

describe('nested blocks cost margin collapsing polynomial work (bjov)', () => {
  beforeEach(() => { resolves.count = 0; });

  it('resolves each level a bounded number of times, not once per root-to-leaf path', () => {
    // `n` counts html, body, the divs and the p. Each level resolves its own
    // children once for the flow mapping and once per escaped edge per level
    // above it, which lands exactly on n^2; the two edges now descend
    // SEPARATE chains, so neither doubles. Under the walk this replaced the
    // count is exponential — 2^19 at depth 16 alone, which is why the numbers
    // below are asserted exactly rather than bounded.
    expect(build(8)).toBe(11 ** 2);
    expect(build(16)).toBe(19 ** 2);
  });

  it('builds a chain as deep as maxNestingDepth allows', () => {
    // The case above is the FAST fence — it reddens in milliseconds, at 2047
    // calls against 121. This one says the fix reaches the depth the library
    // actually permits (LoadLimits.maxNestingDepth defaults to 256), where
    // 2^203 calls means a doubling build does not return at all. Note it
    // HANGS rather than failing under that mutation, as test/flow-overtall's
    // own case does: vitest's timeout cannot interrupt synchronous work.
    const t = Date.now();
    expect(build(200)).toBe(203 ** 2);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
