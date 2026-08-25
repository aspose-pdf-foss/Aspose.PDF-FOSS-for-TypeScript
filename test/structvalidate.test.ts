import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildUaPdf } from './helpers/build-ua-pdf.js';
import type { UaNode } from './helpers/build-ua-pdf.js';
import { buildArtifactPdf } from './helpers/build-artifact-pdf.js';

describe('ValidatePdfUa — report basics', () => {
  it('a well-formed tagged document passes with no errors', () => {
    const report = Document.Open(buildUaPdf()).ValidatePdfUa();
    expect(report.Errors).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('an untagged document fails with a single Tagged error', () => {
    const report = Document.Open(buildUaPdf({ tagged: false })).ValidatePdfUa();
    expect(report.Passed).toBe(false);
    expect(report.Issues.map((i) => i.rule)).toEqual(['Tagged']);
    expect(report.Issues[0].severity).toBe('error');
  });

  it('flags Marked=false as a Tagged error but still runs other rules', () => {
    const report = Document.Open(buildUaPdf({ marked: false })).ValidatePdfUa();
    expect(report.Issues.some((i) => i.rule === 'Tagged')).toBe(true);
    expect(report.Passed).toBe(false);
  });
});

describe('ValidatePdfUa — document-level rules', () => {
  const rules = (opts: Parameters<typeof buildUaPdf>[0]) =>
    Document.Open(buildUaPdf(opts)).ValidatePdfUa().Issues.map((i) => i.rule);

  it('requires a document title', () => {
    expect(rules({ title: null })).toContain('DocumentTitle');
    expect(rules({})).not.toContain('DocumentTitle');
  });

  it('requires /ViewerPreferences /DisplayDocTitle true', () => {
    expect(rules({ displayDocTitle: false })).toContain('DisplayDocTitle');
    expect(rules({})).not.toContain('DisplayDocTitle');
  });

  it('warns when /MarkInfo /Suspects is true', () => {
    const report = Document.Open(buildUaPdf({ suspects: true })).ValidatePdfUa();
    const suspect = report.Issues.find((i) => i.rule === 'Suspects');
    expect(suspect?.severity).toBe('warning');
    expect(report.Passed).toBe(true); // warning does not fail
    expect(rules({})).not.toContain('Suspects');
  });
});

describe('ValidatePdfUa — element rules', () => {
  const rulesFor = (root: UaNode[], extra: Parameters<typeof buildUaPdf>[0] = {}) =>
    Document.Open(buildUaPdf({ root, ...extra })).ValidatePdfUa().Issues.map((i) => i.rule);

  it('flags a non-standard, unmapped structure type', () => {
    const rules = rulesFor([{ type: 'Document', children: [{ type: 'Frobnicate', mcid: 0, text: 'x' }] }]);
    expect(rules).toContain('StandardType');
  });

  it('accepts a custom type mapped through /RoleMap', () => {
    const rules = rulesFor([{ type: 'Document', children: [{ type: 'MyPara', roleMapTo: 'P', mcid: 0, text: 'x' }] }]);
    expect(rules).not.toContain('StandardType');
  });

  it('requires Alt or ActualText on Figure/Formula/Form', () => {
    const missing = rulesFor([{ type: 'Document', children: [{ type: 'Figure' }] }]);
    expect(missing).toContain('IllustrationAlt');
    const withAlt = rulesFor([{ type: 'Document', children: [{ type: 'Figure', alt: 'A chart' }] }]);
    expect(withAlt).not.toContain('IllustrationAlt');
  });

  it('requires a resolvable language for text-bearing elements', () => {
    // catalog /Lang removed and element has no /Lang -> EffectiveLang undefined.
    const rules = rulesFor([{ type: 'Document', children: [{ type: 'P', mcid: 0, text: 'x' }] }], { lang: null });
    expect(rules).toContain('NaturalLanguage');
    // element-level /Lang satisfies it even without catalog /Lang.
    const ok = rulesFor([{ type: 'Document', children: [{ type: 'P', mcid: 0, text: 'x', lang: 'en' }] }], { lang: null });
    expect(ok).not.toContain('NaturalLanguage');
  });
});

describe('ValidatePdfUa — heading nesting', () => {
  const rulesFor = (root: UaNode[]) =>
    Document.Open(buildUaPdf({ root })).ValidatePdfUa().Issues.map((i) => i.rule);

  it('flags a skipped heading level (H1 then H3)', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'H1', mcid: 0, text: 'a' },
      { type: 'H3', mcid: 1, text: 'b' },
    ] }]);
    expect(rules).toContain('HeadingNesting');
  });

  it('accepts consecutive levels and going back up', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'H1', mcid: 0, text: 'a' },
      { type: 'H2', mcid: 1, text: 'b' },
      { type: 'H1', mcid: 2, text: 'c' },
    ] }]);
    expect(rules).not.toContain('HeadingNesting');
  });
});

describe('ValidatePdfUa — table/list nesting', () => {
  const rulesFor = (root: UaNode[]) =>
    Document.Open(buildUaPdf({ root })).ValidatePdfUa().Issues.map((i) => i.rule);

  it('flags a TD outside a TR', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'Table', children: [{ type: 'TD', mcid: 0, text: 'x' }] },
    ] }]);
    expect(rules).toContain('TableStructure');
  });

  it('accepts Table > TR > TD', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'Table', children: [{ type: 'TR', children: [{ type: 'TD', mcid: 0, text: 'x' }] }] },
    ] }]);
    expect(rules).not.toContain('TableStructure');
  });

  it('flags an LI outside an L', () => {
    const rules = rulesFor([{ type: 'Document', children: [{ type: 'LI', mcid: 0, text: 'x' }] }]);
    expect(rules).toContain('ListStructure');
  });

  it('accepts L > LI > LBody', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'L', children: [{ type: 'LI', children: [{ type: 'LBody', mcid: 0, text: 'x' }] }] },
    ] }]);
    expect(rules).not.toContain('ListStructure');
  });
});

describe('ValidatePdfUa — untagged content', () => {
  it('warns (does not error) on a page with loose untagged glyphs', () => {
    const doc = Document.Open(buildArtifactPdf());
    const report = doc.ValidatePdfUa();
    const issue = report.Issues.find((i) => i.rule === 'UntaggedContent');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('warning');
    expect(issue!.page).toBe(doc.Pages[0]);
    expect(report.Passed).toBe(true); // warning only
  });

  it('does not flag a fully-tagged page', () => {
    const report = Document.Open(buildUaPdf()).ValidatePdfUa();
    expect(report.Issues.map((i) => i.rule)).not.toContain('UntaggedContent');
  });
});
