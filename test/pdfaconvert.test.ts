import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';

const open = (b: Uint8Array) => Document.Open(b);

describe('header version from catalog /Version', () => {
  it('emits the catalog /Version in the saved header and reports it', () => {
    const doc = open(buildPdfaPdf({ headerVersion: '1.7', catalogVersion: '1.4' }, 1));
    expect(doc.headerVersion()).toBe('1.4');
    const saved = doc.Save();
    expect(new TextDecoder('latin1').decode(saved.subarray(0, 8))).toBe('%PDF-1.4');
  });
});

describe('ConvertToPdfA — identification/version/fileId', () => {
  it('writes pdfaid and clears Metadata/PdfaIdentification', () => {
    const doc = open(buildPdfaPdf({ omitMetadata: true, infoTitle: 'Doc' }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).toContain('PdfaIdentification');
    const after = doc.ValidatePdfA('2b').Errors.map((e) => e.rule);
    expect(after).not.toContain('Metadata');
    expect(after).not.toContain('PdfaIdentification');
  });
  it('generates a missing /ID', () => {
    const doc = open(buildPdfaPdf({ omitId: true }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).toContain('FileID');
    expect(doc.ValidatePdfA('2b').Errors.map((e) => e.rule)).not.toContain('FileID');
  });
  it('round-trips pdfaid through Save/Open', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Doc' }, 2));
    doc.ConvertToPdfA('2b');
    const reopened = open(doc.Save());
    expect(reopened.GetXmp().pdfaPart).toBe(2);
    expect(reopened.GetXmp().pdfaConformance).toBe('B');
  });
});

describe('ConvertToPdfA — output intent', () => {
  it('adds an sRGB output intent and clears OutputIntent/DeviceColorWithoutIntent', () => {
    const doc = open(buildPdfaPdf({ omitOutputIntent: true, deviceColorContent: true }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).toContain('OutputIntent');
    const after = doc.ValidatePdfA('2b').Errors.map((e) => e.rule);
    expect(after).not.toContain('OutputIntent');
    expect(after).not.toContain('DeviceColorWithoutIntent');
  });
});

describe('ConvertToPdfA — annotations/forms', () => {
  const after = (b: Uint8Array, lvl: any = '2b') => {
    const d = open(b); d.ConvertToPdfA(lvl); return d.ValidatePdfA(lvl).Errors.map((e) => e.rule);
  };
  it('fixes annotation flags', () => {
    expect(after(buildPdfaPdf({ hiddenAnnot: true }))).not.toContain('AnnotationFlags');
  });
  it('clears NeedAppearances', () => {
    expect(after(buildPdfaPdf({ needAppearances: true }))).not.toContain('NeedAppearances');
  });
});

describe('ConvertToPdfA — cosmetic', () => {
  const report = (b: Uint8Array, lvl: any = '2b') => {
    const d = open(b); d.ConvertToPdfA(lvl); return d.ValidatePdfA(lvl);
  };
  it('resets a non-standard blend mode', () => {
    expect(report(buildPdfaPdf({ nonStandardBlend: true })).Warnings.map((i) => i.rule)).not.toContain('BlendMode');
  });
  it('clears /Interpolate', () => {
    expect(report(buildPdfaPdf({ interpolateImage: true })).Warnings.map((i) => i.rule)).not.toContain('ImageInterpolate');
  });
  it('drops /Encoding from a symbolic TrueType', () => {
    expect(report(buildPdfaPdf({ symbolicWithEncoding: true })).Errors.map((i) => i.rule)).not.toContain('FontEncoding');
  });
});

describe('ConvertToPdfA — removals', () => {
  const conv = (b: Uint8Array, lvl: any, opts?: any) => {
    const d = open(b); const r = d.ConvertToPdfA(lvl, opts);
    return { applied: r.applied.map((a) => a.rule), errors: d.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };
  it('removes JavaScript actions', () => {
    const r = conv(buildPdfaPdf({ jsAction: true }, 2), '2b');
    expect(r.applied).toContain('Actions');
    expect(r.errors).not.toContain('Actions');
  });
  it('removes a multimedia annotation', () => {
    expect(conv(buildPdfaPdf({ movieAnnot: true }, 2), '2b').errors).not.toContain('AnnotationSubtype');
  });
  it('removes XFA', () => {
    expect(conv(buildPdfaPdf({ xfa: true }, 2), '2b').errors).not.toContain('XFA');
  });
  it('removes optional content at part 1', () => {
    expect(conv(buildPdfaPdf({ optionalContent: true }, 1), '1b').errors).not.toContain('OptionalContent');
  });
  it('removes a PostScript XObject', () => {
    expect(conv(buildPdfaPdf({ psXObject: true }, 2), '2b').errors).not.toContain('PostScriptXObject');
  });
  it('preserve keeps the construct and reports it unresolved', () => {
    const r = conv(buildPdfaPdf({ xfa: true }, 2), '2b', { preserve: ['xfa'] });
    expect(r.applied).not.toContain('XFA');
    expect(r.errors).toContain('XFA');
  });
});

describe('ConvertToPdfA — ToUnicode (level u)', () => {
  it('synthesizes /ToUnicode for a /Differences font and clears ToUnicode at 2u', () => {
    const doc = open(buildPdfaPdf({ diffEncodingNoToUnicode: true }, 2));
    const report = doc.ConvertToPdfA('2u');
    expect(report.applied.map((a) => a.rule)).toContain('ToUnicode');
    expect(doc.ValidatePdfA('2u').Errors.map((e) => e.rule)).not.toContain('ToUnicode');
  });
  it('does nothing for ToUnicode at level b', () => {
    const doc = open(buildPdfaPdf({ diffEncodingNoToUnicode: true }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).not.toContain('ToUnicode');
  });
});

describe('ConvertToPdfA — report-only + round-trip', () => {
  it('reports a non-embedded font as unresolved', () => {
    const doc = open(buildPdfaPdf({ fontEmbedded: false }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule)).toContain('FontEmbedded');
    expect(report.passed).toBe(false);
  });
  it('declares the part 1 ceiling so the saved header stays at 1.4', () => {
    const doc = open(buildPdfaPdf({ headerVersion: '1.4' }, 1));
    const report = doc.ConvertToPdfA('1b');
    expect(report.passed).toBe(true);
    const saved = doc.Save();
    expect(new TextDecoder('latin1').decode(saved.subarray(0, 8))).toBe('%PDF-1.4');
    expect(open(saved).ValidatePdfA('1b').Errors.map((e) => e.rule)).not.toContain('Version');
  });
  it('converts a messy-but-achievable doc to a passing 2b on save/open', () => {
    const messy = buildPdfaPdf({
      omitOutputIntent: true, deviceColorContent: true, jsAction: true,
      needAppearances: true, movieAnnot: true, omitId: true, omitMetadata: true,
    }, 2);
    const doc = open(messy);
    const report = doc.ConvertToPdfA('2b');
    expect(report.passed).toBe(true);
    const reopened = open(doc.Save());
    expect(reopened.ValidatePdfA('2b').Passed).toBe(true);
  });
});
