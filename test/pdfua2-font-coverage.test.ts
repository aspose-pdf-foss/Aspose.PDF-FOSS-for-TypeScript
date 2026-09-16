import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The 15 rule names ISO 14289-2 8.4.5 adds (`q7hc.4.3`).
 *
 *  A CENSUS rather than a behaviour test: `pdfua2-font.test.ts` asserts each as
 *  a cross-part pair, and this asserts the set is exactly the 15 — so a rule
 *  dropped in a refactor, or a sixteenth quietly added, is a red build. */
const CLAUSE_8_4_5_RULES = [
  'CidSystemInfoMatch',          // 8.4.5.3.1-1
  'CidToGidMap',                 // 8.4.5.3.2-1
  'CMapEmbedded',                // 8.4.5.4-1
  'CMapWModeMatch',              // 8.4.5.4-2
  'CMapReference',               // 8.4.5.4-3
  'FontNotEmbedded',             // 8.4.5.5.1-1
  'GlyphNotPresent',             // 8.4.5.5.1-2
  'GlyphWidthMismatch',          // 8.4.5.6-1
  'TrueTypeNonSymbolicCmap',     // 8.4.5.7-1
  'TrueTypeNonSymbolicEncoding', // 8.4.5.7-2
  'TrueTypeSymbolicEncoding',    // 8.4.5.7-3
  'TrueTypeSymbolicCmap',        // 8.4.5.7-4
  'ToUnicodeMissing',            // 8.4.5.8-1
  'ToUnicodeReserved',           // 8.4.5.8-2
  'NotdefUsed',                  // 8.4.5.9-1
] as const;

describe('ISO 14289-2 8.4.5 rule census', () => {
  it('names exactly fifteen rules', () => {
    expect(CLAUSE_8_4_5_RULES).toHaveLength(15);
    expect(new Set(CLAUSE_8_4_5_RULES).size).toBe(15);
  });

  it('every one is emitted by uafont.ts', () => {
    const src = readFileSync('src/uafont.ts', 'utf8');
    for (const rule of CLAUSE_8_4_5_RULES) {
      expect(src, `${rule} is not emitted anywhere`).toContain(`'${rule}'`);
    }
  });

  it('Table 116 is SIXTY-ONE CMap names', () => {
    // Asserted by SIZE so a half-pasted list is a red build — the rule
    // htmlforeign.ts sets for its five tables. This is NOT predefcmap.ts's set:
    // cmapdata.ts bundles 195 predefined Adobe CMaps, and Table 116 is the
    // subset PDF 2.0 still sanctions. Answering "do we have this CMap" rather
    // than "does PDF 2.0 sanction it" would pass 134 CMaps silently.
    const src = readFileSync('src/uafont.ts', 'utf8');
    const m = /const TABLE_116_CMAPS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    expect(m).not.toBeNull();
    const entries = m![1].match(/'[^']+'/g) ?? [];
    expect(entries).toHaveLength(61);
    expect(new Set(entries).size).toBe(61);
  });

  it('every rule is gated to part 2', () => {
    // Each opens `if (ctx.part !== 2) return [];`, which is what keeps part 1
    // byte-identical. One gate per rule function, so the count must match.
    const src = readFileSync('src/uafont.ts', 'utf8');
    const gates = src.match(/if \(ctx\.part !== 2\) return \[\];/g) ?? [];
    // Fourteen rule FUNCTIONS for fifteen rule NAMES: trueTypeCmapRules emits
    // both 8.4.5.7-1 and -4, since one program load answers both.
    expect(gates).toHaveLength(14);
  });
});
