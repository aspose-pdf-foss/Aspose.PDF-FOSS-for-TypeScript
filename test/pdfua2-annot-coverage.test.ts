import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The 26 rule names ISO 14289-2 8.9 and 8.10 add — 25 from `q7hc.4.2` and
 *  8.10.3.5-1 from `q7hc.4.6`, which completed both clauses.
 *
 *  A CENSUS rather than a behaviour test: `pdfua2-annot.test.ts` asserts each as
 *  a cross-part pair, and this asserts the set is exactly the 25 — so a rule
 *  dropped in a refactor, or a twenty-sixth quietly added, is a red build. */
const CLAUSE_8_9_8_10_RULES = [
  'AnnotInvisible',             // 8.9.2.2-1
  'AnnotNoView',                // 8.9.2.2-2
  'MarkupEnclosure',            // 8.9.2.3-1
  'MarkupRichText',             // 8.9.2.3-2
  'StampDescription',           // 8.9.2.4.7-1
  'InkDescription',             // 8.9.2.4.8-1
  'PopupInTree',                // 8.9.2.4.9-1
  'FileAttachmentRelationship', // 8.9.2.4.10-1
  'SoundProhibited',            // 8.9.2.4.11-1
  'MovieProhibited',            // 8.9.2.4.11-2
  'ScreenDescription',          // 8.9.2.4.12-1
  'ZeroSizeWidget',             // 8.9.2.4.13-1
  'PrinterMarkArtifact',        // 8.9.2.4.14-1
  'TrapNetProhibited',          // 8.9.2.4.15-1
  'WatermarkEnclosure',         // 8.9.2.4.16-1
  'ThreeDDescription',          // 8.9.2.4.19-1
  'RichMediaDescription',       // 8.9.2.4.19-2
  'TabOrder',                   // 8.9.3.3-1
  'AnnotAltMismatch',           // 8.9.4.2-1
  'WidgetEnclosure',            // 8.10.1-1
  'FormWidgetCount',            // 8.10.1-2
  'XfaPresent',                 // 8.10.1-3
  'WidgetDescription',          // 8.10.2.3-1
  'WidgetActionDescription',    // 8.10.2.3-2
  'TextFieldRichValue',         // 8.10.3.3-1
  'SignatureGraphicAlt',        // 8.10.3.5-1 (q7hc.4.6)
] as const;

describe('ISO 14289-2 8.9 / 8.10 rule census', () => {
  it('names exactly twenty-six rules', () => {
    expect(CLAUSE_8_9_8_10_RULES).toHaveLength(26);
    expect(new Set(CLAUSE_8_9_8_10_RULES).size).toBe(26);
  });

  it('every one is emitted by uaannot.ts', () => {
    const src = readFileSync('src/uaannot.ts', 'utf8');
    for (const rule of CLAUSE_8_9_8_10_RULES) {
      expect(src, `${rule} is not emitted anywhere`).toContain(`'${rule}'`);
    }
  });

  it('the markup set is SIXTEEN subtypes', () => {
    // Asserted by SIZE so a half-pasted table is a red build — the rule
    // htmlforeign.ts sets for its five tables. Thirteen from veraPDF's dispatch
    // default branch, plus FileAttachment, Ink and Stamp, whose classes extend
    // GFPDMarkupAnnot. NOT ISO 32000-2 Table 171's list, which counts Sound and
    // Movie; pdfua2-annot.test.ts pins both directions behaviourally.
    const src = readFileSync('src/uaannot.ts', 'utf8');
    const m = /const MARKUP_ANNOTS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    expect(m).not.toBeNull();
    const entries = m![1].match(/'[A-Za-z]+'/g) ?? [];
    expect(entries).toHaveLength(16);
  });

  it('8.10.3.5-1 is present, and its APPROXIMATION is recorded in source', () => {
    // This case asserted the OPPOSITE until `q7hc.4.6`: the rule was deferred
    // because veraPDF states it over a grouped content-item model we do not
    // have. It now ships at ANNOTATION granularity, which is an approximation
    // rather than a transcription — and the acceptance criterion was that
    // whichever route was taken be recorded in source, naming the granularity
    // lost. This asserts that record exists, so a later refactor cannot quietly
    // delete the caveat and leave the rule reading as faithful.
    expect(CLAUSE_8_9_8_10_RULES as readonly string[]).toContain('SignatureGraphicAlt');
    const src = readFileSync('src/uaannot.ts', 'utf8');
    expect(src).toContain('APPROXIMATION');
    expect(src).toContain('ANNOTATION granularity');
    expect(src).toContain('q7hc.4.6');
  });
});
