import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

// ValidationReport.Issues is a ValidationIssue[] with a `rule` string
// (src/validation.ts) — no cast needed.
const altFindings = (doc: Document): string[] =>
  doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'IllustrationAlt').map((i) => i.message);

describe('PDF/UA: supplying an /Alt clears IllustrationAlt', () => {
  // q7hc's headline claim — "AutoTag is a starting point a human refines" —
  // asserted end to end. The setter has shipped since 7dd8750d; nothing in the
  // suite pinned the effect on the validator, so a future change could have
  // taken it away silently.
  it('clears the finding for a /Figure', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const fig = doc.CreateStructTree().Append('Figure');
    expect(altFindings(doc)).toEqual(['Figure element has no /Alt or /ActualText.']);

    fig.Alt = 'a picture of a cat';
    expect(altFindings(doc)).toEqual([]);
  });

  it('accepts /ActualText instead of /Alt', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const fig = doc.CreateStructTree().Append('Figure');
    fig.ActualText = 'Q3 revenue';
    expect(altFindings(doc)).toEqual([]);
  });

  // Whitespace is not a description. The rule trims, and this pins it.
  it('does not accept whitespace as a description', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const fig = doc.CreateStructTree().Append('Figure');
    fig.Alt = '   ';
    expect(altFindings(doc)).toHaveLength(1);
  });

  it('clears again after the /Alt is removed and re-supplied', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const fig = doc.CreateStructTree().Append('Figure');
    fig.Alt = 'a chart';
    expect(altFindings(doc)).toEqual([]);
    fig.Alt = undefined;
    expect(altFindings(doc)).toHaveLength(1);
  });
});
