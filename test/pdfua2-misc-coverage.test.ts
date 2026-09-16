import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The 11 rule names ISO 14289-2 clauses 8.4.3, 8.4.4, 8.6, 8.7, 8.8 and
 *  8.14.1 add (`q7hc.4.4`), completing the epic at 90 of the anchor's 91.
 *
 *  A CENSUS rather than a behaviour test: `pdfua2-text.test.ts` and
 *  `pdfua2-doc.test.ts` assert each as a cross-part pair, and this asserts the
 *  set is exactly the 11 — so a rule dropped in a refactor, or a twelfth
 *  quietly added, is a red build. */
const CLAUSE_RULES = [
  'PuaWithoutReplacement',   // 8.4.3-1
  'ActualTextPua',           // 8.4.3-2
  'AltPua',                  // 8.4.3-3
  'CatalogLangMissing',      // 8.4.4-1
  'LangSyntax',              // 8.4.4-2
  'TextStringPua',           // 8.6-1
  'OcConfigName',            // 8.7-1
  'OcConfigAs',              // 8.7-2
  'DestinationNotStructure', // 8.8-1
  'GoToNotStructure',        // 8.8-2
  'EmbeddedFileDesc',        // 8.14.1-1
] as const;

describe('ISO 14289-2 8.4.3 / 8.4.4 / 8.6 / 8.7 / 8.8 / 8.14.1 rule census', () => {
  it('names exactly eleven rules', () => {
    expect(CLAUSE_RULES).toHaveLength(11);
    expect(new Set(CLAUSE_RULES).size).toBe(11);
  });

  it('every one is emitted by uatext.ts or uadoc.ts', () => {
    const src = readFileSync('src/uatext.ts', 'utf8') + readFileSync('src/uadoc.ts', 'utf8');
    for (const rule of CLAUSE_RULES) {
      expect(src, `${rule} is not emitted anywhere`).toContain(`'${rule}'`);
    }
  });

  it('the private use area is THREE ranges', () => {
    // Asserted by SIZE so a half-pasted table is a red build -- the rule
    // htmlforeign.ts sets for its five tables. veraPDF's PUAHelper holds
    // {0xE000, 0xF8FF, 0xF0000, 0xFFFFD, 0x100000, 0x10FFFD}: the BMP area plus
    // planes 15 and 16. A single-range check silently passes every
    // supplementary PUA code point.
    const src = readFileSync('src/uatext.ts', 'utf8');
    const m = /const PUA_RANGES:[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
    expect(m).not.toBeNull();
    const pairs = m![1].match(/\[0x[0-9a-f]+,\s*0x[0-9a-f]+\]/g) ?? [];
    expect(pairs).toHaveLength(3);
  });

  it('both supplementary bounds end at FFFD, not FFFF', () => {
    // The last two code points of each plane are NONCHARACTERS and sit outside
    // the private use area. Writing FFFF would report on two code points per
    // plane that are not private-use at all.
    const src = readFileSync('src/uatext.ts', 'utf8');
    expect(src).toContain('0xffffd');
    expect(src).toContain('0x10fffd');
    expect(src).not.toContain('0xfffff');
  });

  it('every rule is gated to part 2', () => {
    // Each opens `if (ctx.part !== 2) return [];`, which is what keeps part 1
    // byte-identical. TEN rule FUNCTIONS for eleven rule NAMES:
    // structStringPuaRules emits both 8.4.3-2 and -3 from one element walk,
    // since they differ only in which key they read.
    const src = readFileSync('src/uatext.ts', 'utf8') + readFileSync('src/uadoc.ts', 'utf8');
    const gates = src.match(/if \(ctx\.part !== 2\) return \[\];/g) ?? [];
    expect(gates).toHaveLength(10);
  });
});
