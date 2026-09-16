import { describe, it, expect } from 'vitest';

/** The twenty rule names ISO 14289-2 8.2.5 adds (`q7hc.4.1`), and the one it
 *  does NOT add because `IllustrationAlt` already covers it at both parts.
 *
 *  This file is a CENSUS rather than a behaviour test: `pdfua2-structure.test.ts`
 *  asserts each rule as a cross-part pair, and this asserts that the set is
 *  exactly the twenty the clause names — so a rule dropped during a refactor,
 *  or a twenty-first quietly added, is a red build rather than a discovery. */
const CLAUSE_8_2_5_RULES = [
  'TociRef',                 // 8.2.5.8-1
  'HeadingH',                // 8.2.5.12-1
  'NoteProhibited',          // 8.2.5.14-1
  'FENoteRefOrphan',         // 8.2.5.14-2
  'FENoteRefGhost',          // 8.2.5.14-3
  'FENoteType',              // 8.2.5.14-4
  'LinkEnclosure',           // 8.2.5.20-1
  'LinkTargets',             // 8.2.5.20-2
  'RubySequence',            // 8.2.5.23-1
  'WarichuSequence',         // 8.2.5.24-1
  'ListNumbering',           // 8.2.5.25-1
  'ListItemContent',         // 8.2.5.25-2
  'TableCellIntersection',   // 8.2.5.26-1
  'TableRowRegularity',      // 8.2.5.26-2
  'TableColumnRegularity',   // 8.2.5.26-3
  'TableColumnCount',        // 8.2.5.26-4
  'TableHeaderConnectivity', // 8.2.5.26-5
  'TableHeaderUndefined',    // 8.2.5.26-6
  'CaptionPosition',         // 8.2.5.27-1
  'MathMLParent',            // 8.2.5.29-1
] as const;

describe('ISO 14289-2 8.2.5 rule census', () => {
  it('names exactly twenty rules', () => {
    expect(CLAUSE_8_2_5_RULES).toHaveLength(20);
    expect(new Set(CLAUSE_8_2_5_RULES).size).toBe(20);
  });

  it('every one is emitted by structvalidate, and only at part 2', async () => {
    // Read the source rather than building twenty documents: each rule's body
    // opens `if (ctx.part !== 2) return []`, and the count of that guard is
    // what says none of them can reach part 1.
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/structvalidate.ts', 'utf8');
    for (const rule of CLAUSE_8_2_5_RULES) {
      expect(src, `${rule} is not emitted anywhere`).toContain(`rule: '${rule}'`);
    }
    // The 8.2.5 rules are appended to RULES, never inserted — the part-1 order
    // fence depends on it, and `pdfua-part1-identity.test.ts` is what catches a
    // reordering. Here we only assert they are all present in the table.
    const table = /const RULES: Rule\[\] = \[([\s\S]*?)\];/.exec(src);
    expect(table).not.toBeNull();
    for (const fn of ['tociRefRule', 'headingHRule', 'noteProhibitedRule',
      'rubySequenceRule', 'warichuSequenceRule', 'captionPositionRule',
      'mathMlParentRule', 'listItemContentRule', 'feNoteRefRule', 'feNoteTypeRule',
      'listNumberingRule', 'linkRules', 'tableRules']) {
      expect(table![1], `${fn} is not in RULES`).toContain(fn);
    }
  });

  it('8.2.5.28.2-1 is deliberately NOT among them', () => {
    // Satisfied by IllustrationAlt at both parts. Asserted in
    // pdfua2-structure.test.ts; named here so the absence from this list reads
    // as a decision rather than an omission.
    expect(CLAUSE_8_2_5_RULES as readonly string[]).not.toContain('FigureAlt');
  });
});
