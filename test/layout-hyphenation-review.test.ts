import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { layoutText, winAnsiDriver, type FontDriver } from '../src/layout.js';
import { resolveHyphenation, hyphenator } from '../src/hyphenate.js';

// Final-review findings on v9j3.2 (cost, tail points).
const CR = winAnsiDriver('Courier');   // 6pt per character at 10pt
const goldens = JSON.parse(readFileSync(new URL('./fixtures/hyphenation/goldens.json', import.meta.url), 'utf8')) as
  Record<string, Record<string, string>>;

describe('hyphenation review fixes (v9j3.2)', () => {
  it('breaks a word only where the WHOLE word allows, never where its tail alone would', () => {
    // A tail re-analysed as a word of its own fires word-start patterns at a
    // false boundary: en-GB 'mentation' allows a break 'documentation' does not.
    for (const [tag, words] of Object.entries(goldens)) {
      const h = hyphenator(resolveHyphenation({ lang: tag }));
      for (const word of Object.keys(words)) {
        const legal = new Set(h.points(word));
        for (const chars of [5, 6, 7, 8, 9]) {
          const lines = layoutText(word, CR, 10, chars * 6, 1e9, 12, h).lines.map((l) => l.text);
          let at = 0;
          for (const l of lines.slice(0, -1)) {
            if (!l.endsWith('-')) continue;          // a plain split, not a hyphenation point
            at += l.length - 1;
            expect({ tag, word, chars, at, ok: legal.has(at) }).toEqual({ tag, word, chars, at, ok: true });
          }
        }
      }
    }
  });

  it('lays out a long hyphenatable word in time linear in its length', () => {
    // Counts characters through the driver: hyphenHead re-measured the prefix
    // to every point, once per line — x7 per doubling, 9 s at 8,000 characters.
    let measured = 0;
    const counting: FontDriver = {
      measure: (t, fs) => { measured += t.length; return CR.measure(t, fs); },
      encode: (t) => CR.encode(t), probe: (t) => CR.probe(t),
    };
    const h = hyphenator(resolveHyphenation({ lang: 'en' }));
    const cost = (n: number) => {
      measured = 0;
      layoutText('hyphenation'.repeat(n / 11), counting, 10, 300, 1e9, 12, h);
      return measured;
    };
    const a = cost(2200), b = cost(4400);
    expect(b / a).toBeLessThan(2.6);
    expect(a).toBeLessThan(2200 * 40);
  });
});
