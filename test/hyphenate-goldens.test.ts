import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveHyphenation, hyphenator } from '../src/hyphenate.js';

// Goldens from hyphen@1.14.1, an independent Liang implementation over its own
// copy of the CTAN patterns (scripts/gen-hyphenation-goldens.mjs). The two
// implementations apply their own edge minimums, so both sides are filtered by
// one rule — the language's hyphenmins — before comparing.
const goldens = JSON.parse(readFileSync(new URL('./fixtures/hyphenation/goldens.json', import.meta.url), 'utf8')) as
  Record<string, Record<string, string>>;
/** Points of a '-'-marked word. */
const pointsOf = (marked: string): number[] => {
  const pts: number[] = [];
  let n = 0;
  for (const ch of marked) { if (ch === '-') pts.push(n); else n += ch.length; }
  return pts;
};

describe('hyphenation agrees with hyphen@1.14.1, an independent implementation (v9j3.2)', () => {
  it('covers all nine languages', () => {
    expect(Object.keys(goldens)).toEqual(['en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl']);
  });

  for (const [tag, words] of Object.entries(goldens)) {
    it(tag, () => {
      const r = resolveHyphenation({ lang: tag });
      // Our side runs with the language's own minimums (minLeft counts from the
      // start of an elided word's segment); the oracle's points are filtered by
      // the same minimums counted from the word start.
      const h = hyphenator({ ...r, minWord: 1 });
      for (const [word, marked] of Object.entries(words)) {
        const keep = (p: number) => p >= r.minLeft && word.length - p >= r.minRight;
        expect({ word, points: h.points(word).filter(keep) }).toEqual({ word, points: pointsOf(marked).filter(keep) });
      }
    });
  }
});
