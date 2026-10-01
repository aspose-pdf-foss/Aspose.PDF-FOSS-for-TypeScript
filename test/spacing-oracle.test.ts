import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSpacingOracleDocx } from './helpers/build-spacing-oracle.js';

// m2fp.5: Word 2010's own layout of exact-20pt paragraphs, swept over
// (space-after of P1, space-before of P2) by scripts/gen-spacing-oracle.ps1.
// P3 is the WITNESS: it has no spacing at the P2/P3 boundary, so its position is
// where P2's line really ended. P2's own reported position is recorded too and
// is NOT trustworthy — see the script's header.
const DIR = join(__dirname, 'fixtures', 'docx');
interface Row { after: number; before: number; p1: number; p2reported: number; p3: number }
const oracle = JSON.parse(readFileSync(join(DIR, 'spacing-oracle.json'), 'utf8')) as
  { word: string; lineHeight: number; rows: Row[] };

describe('Word paragraph spacing (oracle)', () => {
  it('the vendored document is the one the builder writes', () => {
    expect(Buffer.compare(readFileSync(join(DIR, 'spacing-oracle.docx')), Buffer.from(buildSpacingOracleDocx()))).toBe(0);
  });

  it('COLLAPSES one paragraph\'s space-after with the next one\'s space-before to the larger', () => {
    expect(oracle.rows.length).toBeGreaterThanOrEqual(7);
    for (const r of oracle.rows) {
      const gap = r.p3 - r.p1 - 2 * oracle.lineHeight;
      expect(gap, `after ${r.after}, before ${r.before}`).toBeCloseTo(Math.max(r.after, r.before), 0);
    }
  });

  it('is not additive: a case where the two readings differ by 12pt or more exists and chose max', () => {
    const split = oracle.rows.filter((r) => Math.min(r.after, r.before) >= 6);
    expect(split.length).toBeGreaterThanOrEqual(3);
    for (const r of split) expect(r.p3 - r.p1 - 2 * oracle.lineHeight).toBeLessThan(r.after + r.before - 1);
  });
});
