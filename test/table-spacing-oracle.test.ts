import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/index.js';
import { buildTableSpacingOracleDocx } from './helpers/build-table-spacing-oracle.js';

// m2fp.10: Word 2010's own layout of a paragraph, a one-cell borderless table
// and a paragraph, swept over (space-after ABOVE the table, space-before BELOW
// it) by scripts/gen-table-spacing-oracle.ps1. P3 is the WITNESS for where P2's
// line ended, as in spacing-oracle.test.ts.
const DIR = join(__dirname, 'fixtures', 'docx');
interface Row { after: number; before: number; p1: number; cell: number; p2reported: number; p3: number }
const oracle = JSON.parse(readFileSync(join(DIR, 'table-spacing-oracle.json'), 'utf8')) as
  { word: string; lineHeight: number; rows: Row[] };
const base = oracle.rows.find((r) => r.after === 0 && r.before === 0)!;

/** The baseline of each named line, top-down, through AddDocx. */
const ours = (after: number, before: number): Record<string, number> => {
  const doc = Document.New();
  const { pages } = doc.AddDocx(buildTableSpacingOracleDocx(after, before));
  const out: Record<string, number> = {};
  for (const f of pages[0].GetTextFragments()) out[f.text.trim()] = -f.quad[1];
  return out;
};

describe('Word spacing across a table (oracle)', () => {
  it('the vendored document is the one the builder writes', () => {
    expect(Buffer.compare(readFileSync(join(DIR, 'table-spacing-oracle.docx')),
      Buffer.from(buildTableSpacingOracleDocx()))).toBe(0);
  });

  it('applies BOTH spacings in full, independently — a table does not collapse them', () => {
    expect(oracle.rows.length).toBeGreaterThanOrEqual(6);
    for (const r of oracle.rows) {
      const tag = `after ${r.after}, before ${r.before}`;
      expect(r.cell - r.p1 - (base.cell - base.p1), tag).toBeCloseTo(r.after, 0);
      expect(r.p3 - r.cell - (base.p3 - base.cell), tag).toBeCloseTo(r.before, 0);
    }
    // Where the two readings differ: a collapse would have cost the smaller.
    expect(oracle.rows.filter((r) => Math.min(r.after, r.before) >= 6).length).toBeGreaterThanOrEqual(3);
  });

  it('AddDocx moves the table and what follows it by the amounts Word does', () => {
    const b = ours(0, 0);
    for (const r of oracle.rows) {
      const o = ours(r.after, r.before);
      const tag = `after ${r.after}, before ${r.before}`;
      expect(o.Cell - o.One - (b.Cell - b.One), tag).toBeCloseTo(r.cell - r.p1 - (base.cell - base.p1), 0);
      expect(o.Two - o.Cell - (b.Two - b.Cell), tag).toBeCloseTo(r.p3 - r.cell - (base.p3 - base.cell), 0);
    }
  });
});
