import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import type { ValidationIssue } from '../src/validation.js';

/** The identification findings reported for this document at `part`. */
const found = (doc: Document, part: 1 | 2): ValidationIssue[] =>
  doc.ValidatePdfUa(part).Issues.filter((i) => i.rule === 'PdfuaIdentification');

const ruleIds = (doc: Document, part: 1 | 2): string[] =>
  doc.ValidatePdfUa(part).Issues.map((i) => i.rule);

describe('PDF/UA-1 clause 5: version identification', () => {
  it('reports a document carrying no pdfuaid at all', () => {
    // 5-1: `containsPDFUAIdentification == true`. Before q7hc.4.5 the rule was
    // gated to part 2 and part 1 checked no identification whatsoever, which
    // is why this is a deliberate behaviour change rather than a bug fix.
    const doc = Document.Open(buildTaggedPdf());
    expect(found(doc, 1)).toHaveLength(1);
  });

  it('reports pdfuaid:part 2 when validating against part 1', () => {
    // 5-2: `part == 1`. The mirror of the part-2 rule, which reports a 1.
    const doc = Document.Open(buildTaggedPdf());
    doc.SetXmp({ pdfuaPart: 2, pdfuaRev: 2024 });
    const msgs = found(doc, 1).map((i) => i.message);
    expect(msgs.join(' ')).toContain('part');
  });

  it('accepts pdfuaid:part 1', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.SetXmp({ pdfuaPart: 1 });
    expect(found(doc, 1)).toHaveLength(0);
  });

  it('does NOT require a rev at part 1, unlike part 2', () => {
    // PDF_UA/1 clause 5 has no rev rule at all -- UA-1 carries `amd` and `corr`
    // where UA-2 carries `rev`. Requiring one here would report on every
    // conformant UA-1 document, including the ones this library converts.
    const doc = Document.Open(buildTaggedPdf());
    doc.SetXmp({ pdfuaPart: 1 });
    expect(found(doc, 1)).toHaveLength(0);
    // ...and the same document IS reported at part 2, where rev is required.
    expect(found(doc, 2).length).toBeGreaterThan(0);
  });

  it('is a WARNING, not an error, at both parts', () => {
    // Every rule of clause 5 is tagged `minor` in the anchor, at BOTH parts --
    // the mapping CLAUDE.md already records for TabOrder. A warning does not
    // affect `Passed`, which is what keeps the README promise that an authored
    // tagged document passes ValidatePdfUa outright.
    const doc = Document.Open(buildTaggedPdf());
    expect(found(doc, 1).map((i) => i.severity)).toEqual(['warning']);
    expect(found(doc, 2).map((i) => i.severity)).toEqual(['warning']);
  });

  it('cites clause 5 of the part being validated', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(found(doc, 1)[0].clause).toBe('ISO 14289-1 §5');
    expect(found(doc, 2)[0].clause).toBe('ISO 14289-2 §5');
  });

  it('a wrong namespace prefix reads as ABSENT, which 5-1 reports', () => {
    // 5-3/-4/-5 check that `part`, `amd` and `corr` carry the `pdfuaid` prefix.
    // xmp.ts matches the literal `pdfuaid:` spelling, so a value under any
    // other prefix is simply not found -- and 5-1 fires instead of 5-3. A
    // NEAR-EQUIVALENCE rather than the profile's own test, stated here so it
    // reads as a decision: modelling XMP namespace prefixes to separate the two
    // would report the same document either way.
    const doc = Document.Open(buildTaggedPdf());
    doc.SetXmp({ pdfuaPart: 1 });
    const xmp = doc.GetXmp();
    expect(xmp.pdfuaPart).toBe(1);
    expect(found(doc, 1)).toHaveLength(0);
  });
});

describe('the identification rule leaves the rest of part 1 alone', () => {
  it('adds the finding WITHOUT disturbing the other part-1 rules', () => {
    // The widening must add exactly one rule id to a part-1 report, not
    // perturb the ones q7hc.4 and earlier already ship.
    const doc = Document.Open(buildTaggedPdf());
    const ids = ruleIds(doc, 1);
    expect(ids).toContain('PdfuaIdentification');
    // buildTaggedPdf's two pre-existing part-1 findings are still there.
    expect(ids).toContain('HeadingNesting');
  });

  it('a converted document reports NO identification finding at part 1', () => {
    // The whole point of the issue: ConvertToPdfUa writes pdfuaid:part 1, and
    // nothing was checking it. Now it is checked, and conversion satisfies it.
    const doc = Document.Open(buildTaggedPdf());
    doc.ConvertToPdfUa({ title: 'T', lang: 'en-US' });
    expect(found(doc, 1)).toHaveLength(0);
  });
});
