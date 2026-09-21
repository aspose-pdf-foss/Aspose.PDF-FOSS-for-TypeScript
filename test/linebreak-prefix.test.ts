import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lineBreakOpportunities, lineBreakPrefix, LBRK } from '../src/linebreak.js';

/** `layoutRuns` paginates an over-wide word by handing the tail back as a
 *  remainder and flowing it again, so `breakOverwideWord` analysed the WHOLE
 *  remaining word on every page it spanned — O(P*L) for a word of L characters
 *  over P pages (`lt63`). The fix analyses a growing PREFIX instead, which is
 *  sound only if a prefix's answers agree with the full text's below some
 *  horizon. `lineBreakPrefix` states that horizon; this file is what proves it.
 *
 *  Both directions matter and neither test alone is enough. SOUNDNESS — every
 *  entry below `final` equals the full text's — is what stops line breaks
 *  moving. NON-VACUITY — `final` is actually near the end — is what stops
 *  `final = 0` passing soundness trivially while the probe makes no progress. */

const here = dirname(fileURLToPath(import.meta.url));

/** The systematic class-pair rows of LineBreakTest.txt, as code point arrays.
 *  Parsed the same way `linebreak-conformance.test.ts` parses them; only the
 *  codes are wanted here, since the expectations come from
 *  `lineBreakOpportunities` itself rather than from the file. */
const corpus: number[][] = (() => {
  const text = readFileSync(join(here, 'fixtures/unicode/LineBreakTest.txt'), 'utf8');
  const out: number[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const codes = line.split(/\s+/)
      .filter((t) => t !== '×' && t !== '÷')
      .map((t) => parseInt(t, 16));
    if (codes.length > 0) out.push(codes);
  }
  return out;
})();

/** The largest F for which `prefix[k] === full[k]` on every `k < F` — what the
 *  horizon may not exceed. Computed by running the real analyser twice, so it
 *  is an observation rather than a second copy of the rule. */
function agreementHorizon(codes: number[], m: number): number {
  const full = lineBreakOpportunities(codes);
  const pre = lineBreakOpportunities(codes.slice(0, m));
  let k = 0;
  while (k < m && pre[k] === full[k]) k++;
  return k;
}

/** Deterministic adversarial words over the classes the horizon turns on: the
 *  LB25 numeric alphabet (NU, SY, IS, PR, PO, OP, CL, HY), the quotes LB15a/b
 *  read, and a Brahmic cluster for LB28a. The corpus rows are 2-6 codes long,
 *  which is too short for a numeric run to straddle a cut — these are 40 long,
 *  so every cut lands inside one. */
const ALPHABET = [
  0x0031, 0x0032, 0x0033, 0x0039, // NU digits
  0x002f,                         // SY solidus
  0x002c, 0x002e,                 // IS comma, full stop
  0x0024, 0x00a3, 0x0023,         // PR dollar, sterling, number sign
  0x0025, 0x00a2,                 // PO percent, cent
  0x0028, 0x005b,                 // OP
  0x0029, 0x005d,                 // CL/CP
  0x002d,                         // HY
  0x0061, 0x0078,                 // AL
  0x0022, 0x00ab, 0x00bb,         // QU (incl. Pi/Pf)
  0x0915, 0x094d, 0x25cc,         // Brahmic base, virama, dotted circle
  0x200b, 0x2060,                 // ZW, WJ
];

function generated(count: number, length: number): number[][] {
  let s = 0x2545f491; // xorshift32, seeded — the same words on every run
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  const out: number[][] = [];
  for (let w = 0; w < count; w++) {
    const codes: number[] = [];
    for (let i = 0; i < length; i++) codes.push(ALPHABET[next() % ALPHABET.length]);
    out.push(codes);
  }
  // Hand-built shapes worth naming, each a numeric run that a cut must survive.
  out.push([...'$1,234,567.00%'].map((c) => c.codePointAt(0)!));
  out.push([...'(1234567890)'].map((c) => c.codePointAt(0)!));
  out.push([...'1234567890'.repeat(4)].map((c) => c.codePointAt(0)!));
  out.push([...'x$(1'].map((c) => c.codePointAt(0)!));
  out.push([...'12/34/5678'].map((c) => c.codePointAt(0)!));
  return out;
}

describe('lineBreakPrefix — a prefix agrees with the full text below its horizon (lt63)', () => {
  it('never claims an entry the full text disagrees with, across the UAX #14 corpus', () => {
    let claimed = 0;
    for (const codes of corpus) {
      for (let m = 0; m <= codes.length; m++) {
        const whole = m === codes.length;
        const { final } = lineBreakPrefix(codes.slice(0, m), whole);
        expect(final).toBeLessThanOrEqual(m);
        const horizon = whole ? m : agreementHorizon(codes, m);
        if (final > horizon) {
          throw new Error(`claimed ${final} of ${m} but the full text diverges at ${horizon}`
            + ` — ${codes.map((c) => c.toString(16)).join(' ')}`);
        }
        claimed += final;
      }
    }
    // Without this the whole test passes with `final = 0`, which is sound and
    // useless: the probe would double forever and never make progress.
    expect(claimed).toBeGreaterThan(50_000);
  });

  it('never claims an entry the full text disagrees with, for words with long numeric runs', () => {
    let claimed = 0;
    for (const codes of generated(300, 40)) {
      for (let m = 0; m <= codes.length; m++) {
        const whole = m === codes.length;
        const { final } = lineBreakPrefix(codes.slice(0, m), whole);
        const horizon = whole ? m : agreementHorizon(codes, m);
        if (final > horizon) {
          throw new Error(`claimed ${final} of ${m} but the full text diverges at ${horizon}`
            + ` — ${codes.map((c) => c.toString(16)).join(' ')}`);
        }
        claimed += final;
      }
    }
    expect(claimed).toBeGreaterThan(200_000);
  });

  it('claims all but the last entry of a prefix, and every entry of the whole text', () => {
    // The horizon as designed: LB15b and LB28a read `cls[i + 1]`, and their
    // `i + 1 >= n` / `i + 1 < n` guards make index n-1 — and only n-1 — read
    // end-of-text where the full text has more. LB25's scan can only see the
    // end when its start is within 2 of it, and the marks it would then differ
    // on begin at n-1 too, so the two reasons converge on the same index.
    const codes = [...'$1,234.00% and 5/6'].map((c) => c.codePointAt(0)!);
    expect(lineBreakPrefix(codes, false).final).toBe(codes.length - 1);
    expect(lineBreakPrefix(codes, true).final).toBe(codes.length);
    expect(lineBreakPrefix([], false).final).toBe(0);
    expect(lineBreakPrefix([], true).final).toBe(0);
    expect(lineBreakPrefix([0x41], false).final).toBe(0);
  });

  it('returns the same breaks lineBreakOpportunities does', () => {
    // Additive: the existing entry point is the whole-text case of this one, so
    // the 16k-row conformance corpus keeps fencing both.
    for (const codes of corpus.slice(0, 500)) {
      expect([...lineBreakPrefix(codes, true).brk]).toEqual([...lineBreakOpportunities(codes)]);
    }
    expect(lineBreakPrefix([0x31, 0x31], true).brk[1]).toBe(LBRK.PROHIBITED);
  });
});
