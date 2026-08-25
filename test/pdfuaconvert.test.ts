import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildUaPdf } from './helpers/build-ua-pdf.js';

const open = (b: Uint8Array) => Document.Open(b);

describe('ConvertToPdfUa — identification', () => {
  it('writes pdfuaid:part 1 and reports the action', () => {
    const doc = open(buildUaPdf());
    const report = doc.ConvertToPdfUa();
    expect(report.applied.map((a) => a.rule)).toContain('PdfuaIdentification');
    expect(doc.GetXmp().pdfuaPart).toBe(1);
  });
  it('round-trips pdfuaid through Save/Open', () => {
    const doc = open(buildUaPdf());
    doc.ConvertToPdfUa();
    expect(open(doc.Save()).GetXmp().pdfuaPart).toBe(1);
  });
});

describe('ConvertToPdfUa — marked + lang', () => {
  const after = (b: Uint8Array, opts?: any) => {
    const d = open(b); d.ConvertToPdfUa(opts); return d.ValidatePdfUa().Errors.map((e) => e.rule);
  };
  it('sets /MarkInfo /Marked true', () => {
    const doc = open(buildUaPdf({ marked: false }));
    const report = doc.ConvertToPdfUa();
    expect(report.applied.map((a) => a.rule)).toContain('Tagged');
    expect(doc.ValidatePdfUa().Errors.map((e) => e.rule)).not.toContain('Tagged');
  });
  it('does not fabricate tagging for an untagged doc', () => {
    const doc = open(buildUaPdf({ tagged: false }));
    const report = doc.ConvertToPdfUa();
    expect(report.applied.map((a) => a.rule)).not.toContain('Tagged');
    expect(doc.ValidatePdfUa().Errors.map((e) => e.rule)).toContain('Tagged');
  });
  it('sets catalog /Lang from opts.lang', () => {
    expect(after(buildUaPdf({ lang: null }), { lang: 'en-US' })).not.toContain('NaturalLanguage');
  });
  it('leaves NaturalLanguage unresolved when no lang supplied and none present', () => {
    expect(after(buildUaPdf({ lang: null }))).toContain('NaturalLanguage');
  });
});

describe('ConvertToPdfUa — title + DisplayDocTitle', () => {
  const after = (b: Uint8Array, opts?: any) => {
    const d = open(b); d.ConvertToPdfUa(opts); return d.ValidatePdfUa().Errors.map((e) => e.rule);
  };
  it('sets a missing title from opts.title', () => {
    expect(after(buildUaPdf({ title: null }), { title: 'My Doc' })).not.toContain('DocumentTitle');
  });
  it('leaves DocumentTitle unresolved when no title is available', () => {
    expect(after(buildUaPdf({ title: null }))).toContain('DocumentTitle');
  });
  it('keeps an existing title (no opts.title needed)', () => {
    expect(after(buildUaPdf({ title: 'Present' }))).not.toContain('DocumentTitle');
  });
  it('sets /ViewerPreferences /DisplayDocTitle true', () => {
    expect(after(buildUaPdf({ displayDocTitle: false }))).not.toContain('DisplayDocTitle');
  });
});

describe('ConvertToPdfUa — roleMap + suspects', () => {
  // A custom-role node that is NOT mapped in the fixture's /RoleMap.
  const customRoot = [{ type: 'Document', children: [{ type: 'MyHeading', mcid: 0, text: 'H' }] }];
  const after = (b: Uint8Array, opts?: any) => {
    const d = open(b); d.ConvertToPdfUa(opts); return d.ValidatePdfUa().Errors.map((e) => e.rule);
  };
  it('maps an unmapped custom role via opts.roleMap', () => {
    const errs = after(buildUaPdf({ root: customRoot }), { roleMap: { MyHeading: 'H1' } });
    expect(errs).not.toContain('StandardType');
  });
  it('skips a mapping whose target is non-standard (role stays unresolved)', () => {
    const errs = after(buildUaPdf({ root: customRoot }), { roleMap: { MyHeading: 'NotAType' } });
    expect(errs).toContain('StandardType');
  });
  it('clears /MarkInfo /Suspects', () => {
    const doc = open(buildUaPdf({ suspects: true }));
    const report = doc.ConvertToPdfUa();
    expect(report.applied.map((a) => a.rule)).toContain('Suspects');
    expect(doc.ValidatePdfUa().Warnings.map((w) => w.rule)).not.toContain('Suspects');
  });
});

describe('ConvertToPdfUa — end to end', () => {
  // All-mechanical defects fixable with matching opts.
  const fixable = () => buildUaPdf({
    marked: false, lang: null, title: null, displayDocTitle: false, suspects: true,
    root: [{ type: 'Document', children: [{ type: 'MyHeading', mcid: 0, text: 'H' }] }],
  });
  it('reaches passed=true once every mechanical defect is fixed', () => {
    const doc = open(fixable());
    const report = doc.ConvertToPdfUa({ lang: 'en-US', title: 'Doc', roleMap: { MyHeading: 'H1' } });
    expect(report.passed).toBe(true);
    expect(report.unresolved).toHaveLength(0);
  });
  it('leaves human-authoring defects unresolved but still applies mechanical fixes', () => {
    // A Figure with no /Alt cannot be auto-fixed.
    const doc = open(buildUaPdf({
      marked: false,
      root: [{ type: 'Document', children: [{ type: 'Figure', mcid: 0, text: 'x' }] }],
    }));
    const report = doc.ConvertToPdfUa();
    expect(report.passed).toBe(false);
    expect(report.unresolved.map((e) => e.rule)).toContain('IllustrationAlt');
    expect(report.applied.map((a) => a.rule)).toContain('Tagged'); // mechanical fix still done
  });
  it('persists all fixes across Save/Open', () => {
    const doc = open(fixable());
    doc.ConvertToPdfUa({ lang: 'en-US', title: 'Doc', roleMap: { MyHeading: 'H1' } });
    const r = open(doc.Save());
    expect(r.Lang).toBe('en-US');
    expect(r.ValidatePdfUa().Passed).toBe(true);
    expect(r.GetXmp().pdfuaPart).toBe(1);
  });
});
