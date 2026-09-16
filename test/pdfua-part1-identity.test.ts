import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

/** A compact, ORDER-PRESERVING projection of a report. ValidationReport.Issues
 *  is an ordered array and that order is observable, so the rule-table refactor
 *  must not permute it — and no existing assertion checks sequence, only
 *  membership. This is the only thing in the suite that can see a reordering. */
const shape = (doc: Document): string[] =>
  doc.ValidatePdfUa().Issues.map((i) => `${i.severity} ${i.rule} ${i.message}`);

// These snapshots are a FENCE, not a golden to refresh when they go red. They
// have moved exactly ONCE, in `q7hc.4.5`, which widened the clause-5
// identification rule to part 1 — a deliberate behaviour change the issue asked
// for, and one whose whole visible effect is a single appended line per
// snapshot. Verified before accepting: nothing was permuted and no existing
// line changed. A future red here means something else moved; read the diff
// rather than running `-u`.
describe('PDF/UA-1 report identity (refactor fence)', () => {
  it('reports the tagged fixture in a stable order', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(shape(doc)).toMatchSnapshot();
  });

  it('reports an untagged document in a stable order', () => {
    const doc = Document.Open(buildStampTarget());
    expect(shape(doc)).toMatchSnapshot();
  });

  it('reports a document with a tree but no title in a stable order', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    root.Append('Document').Append('P');
    expect(shape(doc)).toMatchSnapshot();
  });
});

describe('PDF/A level a folds in PDF/UA-1, never part 2', () => {
  // PDF/A level 'a' means PDF/UA-1 tagging. Widening this call to part 2 would
  // start asking a PDF/A-2a document for a PDF 2.0 namespace — silently, since
  // every UA issue is prefixed 'UA:' either way.
  it('does not report the part-2 namespace rules at level a', () => {
    const doc = Document.Open(buildTaggedPdf());
    const rules = doc.ValidatePdfA('2a').Issues.map((i) => i.rule);
    expect(rules.some((r) => r.startsWith('UA:'))).toBe(true);
    expect(rules).not.toContain('UA:StructureNamespace');
    expect(rules).not.toContain('UA:PdfuaIdentification');
  });
});
