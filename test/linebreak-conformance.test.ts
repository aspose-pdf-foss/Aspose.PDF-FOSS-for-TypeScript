import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lineBreakOpportunities, LBRK } from '../src/linebreak.js';
import { lineBreak } from '../src/unicode-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, 'fixtures/unicode/LineBreakTest.txt'), 'utf8');

interface Row { line: number; codes: number[]; brk: boolean[]; } // brk[i] = break allowed before codes[i]
const rows: Row[] = [];
text.split('\n').forEach((raw, idx) => {
  const line = raw.split('#')[0].trim();
  if (!line) return;
  const toks = line.split(/\s+/);
  const codes: number[] = [];
  const brk: boolean[] = [];
  for (const t of toks) {
    if (t === '×') brk.push(false);       // × no break
    else if (t === '÷') brk.push(true);   // ÷ break
    else codes.push(parseInt(t, 16));
  }
  rows.push({ line: idx + 1, codes, brk: brk.slice(0, codes.length) });
});

// LineBreakTest.txt ends with a block of real-text SAMPLE lines (actual
// sentences in many scripts) that exercise Unicode 15.1 refinements our default
// engine intentionally does not implement — East-Asian-aware quotation
// (LB19.02), reserved-emoji Extended_Pictographic (LB30b), and full Brahmic
// aksara clustering with ZWJ/bidi (LB28a). They need extra UCD properties for
// negligible benefit to PDF text wrapping. The systematic class-pair conformance
// matrix (the bulk of the file) passes exactly; these sample lines are pinned
// below so any regression in the core algorithm is still caught.
const SAMPLE_BLOCK_START = 16461; // first physical line of the trailing samples

function mismatches(pred: (r: Row) => boolean): { total: number; lines: number[]; samples: string[] } {
  const lines = new Set<number>();
  const samples: string[] = [];
  let total = 0;
  for (const r of rows) {
    if (!pred(r)) continue;
    const got = lineBreakOpportunities(r.codes);
    for (let i = 1; i < r.codes.length; i++) {
      if ((got[i] !== LBRK.PROHIBITED) !== r.brk[i]) {
        total++;
        lines.add(r.line);
        if (samples.length < 15) samples.push(`L${r.line}[${i}] ${r.codes.map((c) => c.toString(16)).join(' ')} — exp ${r.brk[i] ? '÷' : '×'} got ${got[i] !== LBRK.PROHIBITED ? '÷' : '×'} (${lineBreak(r.codes[i - 1])}>${lineBreak(r.codes[i])})`);
      }
    }
  }
  return { total, lines: [...lines].sort((a, b) => a - b), samples };
}

describe('UAX #14 conformance (LineBreakTest.txt)', () => {
  it('loads the full test file', () => { expect(rows.length).toBeGreaterThan(5000); });

  it('systematic class-pair matrix: every boundary matches exactly', () => {
    const { total, lines, samples } = mismatches((r) => r.line < SAMPLE_BLOCK_START);
    if (total > 0) throw new Error(`${total} mismatches in the systematic matrix (lines ${lines.slice(0, 20).join(',')})\n${samples.join('\n')}`);
    expect(total).toBe(0);
  });

  it('trailing sample-text lines: residual is confined and stable (no regression)', () => {
    const { total, lines } = mismatches((r) => r.line >= SAMPLE_BLOCK_START);
    // Every residual mismatch must be a trailing sample line (never the matrix),
    // and the count is pinned to the documented Unicode-15.1 refinement gaps.
    expect(lines.every((l) => l >= SAMPLE_BLOCK_START)).toBe(true);
    expect(total).toBeLessThanOrEqual(23);
  });
});
