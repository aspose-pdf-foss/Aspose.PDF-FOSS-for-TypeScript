import { describe, it, expect } from 'vitest';
import { layoutText, FontDriver } from '../src/layout.js';
import { lineBreakOpportunities, LBRK } from '../src/linebreak.js';

// 10pt per code point; encode/probe count code points (monospace stub).
const stub: FontDriver = {
  measure: (t) => [...t].length * 10,
  encode: (t) => new Uint8Array([...t].length),
  probe: (t) => [...t].length,
};

describe('layoutText — UAX #14 over-wide tokens', () => {
  it('wraps a space-less CJK run at ideograph boundaries', () => {
    // box width 35 → 3 chars per line (30 ≤ 35 < 40).
    const { lines } = layoutText('中文字符测试', stub, 10, 35, 1000, 12);
    expect(lines.map((l) => l.text)).toEqual(['中文字', '符测试']);
  });

  it('does NOT insert a space when reflowing a CJK break (remainder)', () => {
    // height fits 1 line only → remainder is the rest with NO separator.
    const { lines, remainder } = layoutText('中文字符', stub, 10, 25, 12, 12);
    expect(lines.map((l) => l.text)).toEqual(['中文']);
    expect(remainder).toBe('字符'); // no space injected between 文 and 字
  });

  it('leaves normal Latin word-wrap byte-identical (spaces only)', () => {
    const { lines, remainder } = layoutText('alpha beta gamma', stub, 10, 100, 1000, 12);
    // 'alpha beta' = 10 chars = 100 ≤ 100; + ' gamma' overflows → wrap.
    expect(lines.map((l) => l.text)).toEqual(['alpha beta', 'gamma']);
    expect(remainder).toBe('');
  });

  it('does not sub-break a hyphenated word that already fits', () => {
    const { lines } = layoutText('well-known', stub, 10, 200, 1000, 12);
    expect(lines.map((l) => l.text)).toEqual(['well-known']); // untouched
  });

  it('breaks an over-wide hyphenated word at the hyphen (improvement over overflow)', () => {
    // 'well-known' = 10 chars = 100pt; box 60 → 'well-'(50) fits, 'known' next.
    const { lines } = layoutText('well-known', stub, 10, 60, 1000, 12);
    expect(lines.map((l) => l.text)).toEqual(['well-', 'known']);
  });
});

/** `lt63` made the UAX #14 analysis behind an over-wide word's split LAZY — a
 *  growing prefix rather than the whole remaining word on every page. These are
 *  the fence for that, and they are written against an oracle OUTSIDE the split:
 *  `lineBreakOpportunities` over the whole word, which the 16k-row corpus in
 *  `linebreak-conformance.test.ts` pins independently.
 *
 *  Both cases held before the change and must hold after — the failure they
 *  exist for is a prefix whose answers were not yet final being believed, which
 *  MOVES a line break rather than throwing. Every word here is BMP, so a code
 *  unit offset and a code point index are the same number. */
describe('layoutText — an over-wide word breaks the same however it paginates (lt63)', () => {
  const lineTexts = (word: string, boxWidth: number, linesPerPage: number): string[] => {
    let text = word;
    const out: string[] = [];
    for (let page = 0; text.length > 0 && page < 2_000; page++) {
      const r = layoutText(text, stub, 10, boxWidth, 10 * linesPerPage, 10);
      if (r.lines.length === 0) break;
      out.push(...r.lines.map((l) => l.text));
      text = r.remainder;
    }
    return out;
  };

  // Long enough to span many pages at every height below, and built so that
  // break opportunities and numeric runs interleave: every cut lands inside an
  // LB25 run for at least one of the page heights.
  const WORDS = [
    'ab-12/34-cd-$5,678.90%-'.repeat(20),
    'well-known-'.repeat(40),
    '$1,234.00%-and-5/6-'.repeat(25),
    'a1-b2-c3-'.repeat(50),
  ];

  it('produces the same lines at 1, 2, 3, 5, 7 and 13 lines a page', () => {
    for (const word of WORDS) {
      const ref = lineTexts(word, 100, 1_000); // the whole word in one go
      expect(ref.join('')).toBe(word);
      expect(ref.length).toBeGreaterThan(20); // discriminating, not one line
      for (const perPage of [1, 2, 3, 5, 7, 13]) {
        expect(lineTexts(word, 100, perPage)).toEqual(ref);
      }
    }
  });

  it('breaks only where UAX #14 allows a break in the WHOLE word', () => {
    for (const word of WORDS) {
      const brk = lineBreakOpportunities([...word].map((c) => c.codePointAt(0)!));
      for (const perPage of [1, 3, 7]) {
        let at = 0;
        for (const line of lineTexts(word, 100, perPage)) {
          at += line.length;
          if (at >= word.length) break;
          if (brk[at] === LBRK.PROHIBITED) {
            throw new Error(`broke at ${at} (${JSON.stringify(word.slice(at - 4, at + 4))}),`
              + ` which UAX #14 prohibits — ${perPage} lines a page`);
          }
        }
      }
    }
  });
});

/** The two cases above are the general fence and they measure NOTHING for the
 *  rule that actually matters — believing a prefix past `lineBreakPrefix`'s
 *  horizon leaves both of them green (measured). The risk is concentrated at
 *  ONE index, the last of whichever prefix has been analysed, and none of those
 *  words happens to break differently there. They are kept because they DO hold
 *  the two rules they name: reverting the split to eager reddens neither, but
 *  analysing only the first prefix and never growing it reddens both.
 *
 *  This is the word that does. `'a' * 62 + '$(' + '1' * n` puts `$` at 62 and
 *  `(` at 63, so a 64-code-point prefix — the probe's first step — ends exactly
 *  after the `(`. In the WHOLE word LB25 matches `(PR)(OP)NU...` from index 62
 *  and prohibits index 63; in the prefix that scan runs off the end before it
 *  finds the NU, so index 63 falls through to `PAIR[PR][OP]`, which ALLOWS a
 *  break. Nothing else in the word is a break opportunity — AL x AL, AL x PR,
 *  OP x anything and NU x NU are all prohibited — so the correct answer is one
 *  piece, and a build that believes the prefix emits two. */
describe('layoutText — an over-wide word is not broken on an unsettled prefix (lt63)', () => {
  // ONE case, and the obvious generalization to 126 and 254 measures NOTHING —
  // both were written, run against the mutation and found dead. The reason is
  // structural rather than a fixture accident: `atLeast(i + 1)` materializes
  // one code point PAST `i` before `brkAt(i)` is ever consulted, so from the
  // second probe step onward the analysed prefix always overshoots the index
  // being asked about and the horizon is never the thing answering. Only the
  // FIRST step, which supplies exactly 64, ends on the index it protects.
  for (const at of [62]) {
    it(`does not break at a numeric run that straddles the prefix ending at ${at + 2}`, () => {
      const word = 'a'.repeat(at) + '$(' + '1'.repeat(60);
      const codes = [...word].map((c) => c.codePointAt(0)!);
      const brk = lineBreakOpportunities(codes);
      // The premise, asserted rather than assumed: UAX #14 permits no break
      // anywhere in this word, so any line past the first is a defect.
      expect([...brk].slice(1).every((v) => v === LBRK.PROHIBITED)).toBe(true);

      // The box must overflow just PAST the straddle or `lastOpp` never reaches
      // it and the case measures nothing whatever the code does.
      const { lines } = layoutText(word, stub, 10, (at + 6) * 10, 10_000, 10);
      expect(lines.map((l) => l.text)).toEqual([word]);
    });
  }
});
