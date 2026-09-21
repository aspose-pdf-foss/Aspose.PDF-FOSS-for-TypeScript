import { describe, it, expect } from 'vitest';
import { layoutRuns, winAnsiDriver } from '../src/layout.js';
import type { FontDriver } from '../src/layout.js';
import { parseMarkdown } from '../src/markdown.js';
import { scanLinkDestination } from '../src/mdscan.js';

const CR = winAnsiDriver('Courier');
const SIZE = 12;
const LEADING = 14.4;

/** A driver that records how many CHARACTERS it was asked to measure. Counting
 *  through the DRIVER rather than a module mock, because `layoutRuns` takes one
 *  as an argument — so the cost is observable from outside with nothing
 *  stubbed. `layout-pagination-cost.test.ts`'s arrangement. */
function counting(): { driver: FontDriver; chars: () => number; calls: () => number } {
  let chars = 0;
  let calls = 0;
  return {
    chars: () => chars,
    calls: () => calls,
    driver: {
      measure: (t, fs) => { chars += t.length; calls++; return CR.measure(t, fs); },
      encode: (t) => CR.encode(t),
      probe: (t) => CR.probe(t),
    },
  };
}

/** `breakOverwideWord` measured `measure(start, i)` for EVERY character of an
 *  over-wide word and then used the answer only as `overflow && lastOpp >
 *  start`. A word with no UAX #14 break opportunity never sets `lastOpp` — AL x
 *  AL and OP x anything are both PROHIBITED, so `'*'.repeat(n)` and
 *  `'['.repeat(n)` are each one unbreakable word — and every one of those L
 *  measurements was computed and discarded. Each is O(i - start), because
 *  `spanWidth` re-walks the prefix, so the whole word cost O(L^2) characters
 *  through the driver.
 *
 *  This is the RENDER half of `lqs1`, and it is the whole cost of that issue's
 *  first two inputs: `parseMarkdown` alone is ~0 ms for both at n = 20,000
 *  while `AddMarkdown` took 3.7 s. */
describe('an unbreakable word is not measured per character (lqs1)', () => {
  it('measures a linear number of characters for a word with no break opportunity', () => {
    const c = counting();
    const n = 2_000;
    layoutRuns([{ text: '*'.repeat(n), driver: c.driver, fontSize: SIZE }],
      60, LEADING * 40, LEADING, SIZE);
    // Quadratic is n(n+1)/2 = 2,001,000 characters. The surviving cost is the
    // over-wide test plus one pack per piece, which is a small multiple of n.
    expect(c.chars()).toBeLessThan(20 * n);
  });

  it('costs the same per character as the word doubles', () => {
    // The sharper statement, and the one a loose bound cannot make: doubling
    // the word must not more than double the work.
    const small = counting();
    const large = counting();
    layoutRuns([{ text: '['.repeat(2_000), driver: small.driver, fontSize: SIZE }],
      60, LEADING * 40, LEADING, SIZE);
    layoutRuns([{ text: '['.repeat(4_000), driver: large.driver, fontSize: SIZE }],
      60, LEADING * 40, LEADING, SIZE);
    expect(large.chars()).toBeLessThan(small.chars() * 3);
  });

  it('does not re-split a page-long word on every page', () => {
    // `pl2h`'s rule — wrap and keep in one pass, never wrap it all and keep a
    // prefix — did not reach `breakOverwideWord`, which materialized EVERY
    // piece of the word and let `keep()` discard all but the first. The
    // remainder is re-flowed, so a word longer than the page was re-split once
    // per page. Measured at 5 lines a page over an 8,000-character word before
    // the fix: 506,103 driver calls over 4,348,882 characters, growing 4x per
    // doubling; after, 10,593 calls over 88,890 characters, growing 2x.
    const run = (n: number): { calls: number; chars: number } => {
      const c = counting();
      let text = '[a]('.repeat(n);
      for (let page = 0; text.length > 0 && page < 5_000; page++) {
        const r = layoutRuns([{ text, driver: c.driver, fontSize: SIZE }],
          60, LEADING * 5, LEADING, SIZE);
        if (r.lines.length === 0) break;
        text = r.remainder.map((x) => x.text).join('');
      }
      return { calls: c.calls(), chars: c.chars() };
    };
    const small = run(500);
    const large = run(1_000);
    // Doubling the word must not more than double either count. A quadratic
    // build lands at 4x — 128,053 calls against 32,778 — so the margin here is
    // wide enough to be about the SHAPE rather than about a constant.
    expect(large.calls).toBeLessThan(small.calls * 3);
    expect(large.chars).toBeLessThan(small.chars * 3);
  });

  it('does not measure a whole over-wide word to learn that it is over-wide', () => {
    // The other half, and one page is enough to see it: the test itself was
    // `spanWidth(i, j) > boxWidth` over the ENTIRE word, which is what left the
    // measured characters growing 3.6x per doubling after the split went lazy.
    // A 60pt box at 7.2pt/char holds 8 characters, so the growing prefix probe
    // settles the question inside its first 64 whatever the word's length.
    const c = counting();
    const n = 8_000;
    // A word with break opportunities every four characters, so the ONE line
    // kept is small and the whole-word measure is the only large one left.
    layoutRuns([{ text: '[a]('.repeat(n / 4), driver: c.driver, fontSize: SIZE }],
      60, LEADING, LEADING, SIZE);
    // 211 characters after the fix, against 8,000 for the full measure alone.
    expect(c.chars()).toBeLessThan(1_000);
  });

  it('charges nothing extra for an ordinary short word', () => {
    // The probe must not cost the common case: a word shorter than the first
    // 64-character probe skips the loop entirely and takes the single full
    // measure it always did. An EXACT count, because a bound cannot see this —
    // dropping the probe's start to 4 lands at 102 and dropping `spanWiderThan`
    // altogether lands back at 86, so only the exact figure separates the
    // probe's SIZE from its presence. The companion case above pins the other
    // direction.
    const c = counting();
    layoutRuns([{ text: 'alpha bravo charlie delta echo', driver: c.driver, fontSize: SIZE }],
      600, LEADING * 4, LEADING, SIZE);
    expect(c.chars()).toBe(86);
  });

  it('still breaks an over-wide word that DOES have an opportunity', () => {
    // The guard must not cost the feature. UAX #14 allows a break AFTER a
    // hyphen (and prohibits one before it), so `a-a-a-…` is a single word —
    // no space in it — that the break search must still cut into pieces.
    const r = layoutRuns([{ text: 'a-'.repeat(40), driver: CR, fontSize: SIZE }],
      60, LEADING * 40, LEADING, SIZE);
    expect(r.lines.length).toBeGreaterThan(1);
    // And every piece fits the box, which is what the search is for.
    expect(r.remainder).toHaveLength(0);
  });
});

/** The PARSE half. Both sites are reached once per close bracket and each
 *  scanned to end-of-subject, so `'[a]('.repeat(n)` was quadratic twice over:
 *  at n = 10,000 (40 KB of input) the destination scan touched 200 M characters
 *  and the three `subject.slice(pos)` calls allocated 400 M. */
describe('a link destination scan is bounded (lqs1)', () => {
  it('refuses a destination nested past 32 parens', () => {
    // cmark's `manual_scan_link_url_2` caps nesting at 32 and returns -1 past
    // it. Without a cap the scan runs to the end of the subject on every close
    // bracket and then fails on `depth !== 0` anyway, so the work is thrown
    // away — which is exactly the quadratic.
    expect(scanLinkDestination('('.repeat(32) + ')'.repeat(32), 0)).toBeDefined();
    expect(scanLinkDestination('('.repeat(33) + ')'.repeat(33), 0)).toBeUndefined();
  });

  it('does not scan the whole subject once per close bracket', () => {
    const n = 20_000;
    const t0 = Date.now();
    parseMarkdown('[a]('.repeat(n) + 'x');
    // 6.1 s before the fix at this size, ~20 ms after. The budget is loose on
    // purpose: it is here to catch the quadratic, not to pin a constant.
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('parses a run of close brackets in linear time', () => {
    const t0 = Date.now();
    parseMarkdown('[a](b) '.repeat(20_000));
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
