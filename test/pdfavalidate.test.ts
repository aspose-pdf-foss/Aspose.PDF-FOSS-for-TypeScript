import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';

const open = (bytes: Uint8Array) => Document.Open(bytes);

describe('ValidatePdfA — harness', () => {
  it('clean document passes at 2b with zero errors and no warnings', () => {
    const doc = open(buildPdfaPdf({}, 2));
    const report = doc.ValidatePdfA('2b');
    expect(report.Errors).toEqual([]);
    expect(report.Warnings).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('flags an encrypted document', () => {
    // Round-trip the clean fixture through real encryption (a forged /Encrypt
    // would make Document.Open reject the file), then re-open and validate.
    const encrypted = Document.Open(buildPdfaPdf({}, 2)).Save({ encrypt: { userPassword: '' } });
    const report = Document.Open(encrypted).ValidatePdfA('2b');
    expect(report.Errors.map((e) => e.rule)).toContain('Encryption');
    expect(report.Passed).toBe(false);
  });
});

describe('ValidatePdfA — file/structure', () => {
  const rules = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags a missing /ID', () => {
    expect(rules(buildPdfaPdf({ omitId: true }))).toContain('FileID');
  });
  it('flags an over-ceiling version at part 1', () => {
    expect(rules(buildPdfaPdf({ headerVersion: '1.7' }, 1), '1b')).toContain('Version');
  });
  it('passes 1.4 header at part 1', () => {
    expect(rules(buildPdfaPdf({ headerVersion: '1.4' }, 1), '1b')).not.toContain('Version');
  });
  it('flags an external stream reference', () => {
    expect(rules(buildPdfaPdf({ externalStream: true }))).toContain('ExternalStream');
  });
  it('flags an LZW filter', () => {
    expect(rules(buildPdfaPdf({ lzwStream: true }))).toContain('LZW');
  });
  it('flags a PostScript XObject', () => {
    expect(rules(buildPdfaPdf({ psXObject: true }))).toContain('PostScriptXObject');
  });
  it('flags a reference XObject', () => {
    expect(rules(buildPdfaPdf({ refXObject: true }))).toContain('ReferenceXObject');
  });
  it('flags optional content at part 1 but not part 2', () => {
    expect(rules(buildPdfaPdf({ optionalContent: true }, 1), '1b')).toContain('OptionalContent');
    expect(rules(buildPdfaPdf({ optionalContent: true }, 2), '2b')).not.toContain('OptionalContent');
  });
});

describe('ValidatePdfA — metadata', () => {
  const allIssues = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Issues;
  const ids = (bytes: Uint8Array, level: any = '2b') => allIssues(bytes, level).map((i) => i.rule);

  it('flags a missing metadata stream', () => {
    expect(ids(buildPdfaPdf({ omitMetadata: true }))).toContain('Metadata');
  });
  it('flags a pdfaid part mismatch', () => {
    expect(ids(buildPdfaPdf({ pdfaPart: '1' }, 2))).toContain('PdfaIdentification');
  });
  it('flags a pdfaid conformance mismatch (claim u, xmp says B)', () => {
    expect(ids(buildPdfaPdf({ pdfaConformance: 'B' }, 2), '2u')).toContain('PdfaIdentification');
  });
  it('flags Info/XMP title disagreement as error at part 1', () => {
    const issues = allIssues(buildPdfaPdf({ infoTitle: 'A', xmpTitle: 'B' }, 1), '1b');
    const c = issues.find((i) => i.rule === 'XmpInfoConsistency');
    expect(c?.severity).toBe('error');
  });
  it('reports Info/XMP disagreement as warning at part 2', () => {
    const issues = allIssues(buildPdfaPdf({ infoTitle: 'A', xmpTitle: 'B' }, 2), '2b');
    const c = issues.find((i) => i.rule === 'XmpInfoConsistency');
    expect(c?.severity).toBe('warning');
  });
});

describe('ValidatePdfA — fonts', () => {
  const ids = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags a non-embedded font', () => {
    expect(ids(buildPdfaPdf({ fontEmbedded: false }))).toContain('FontEmbedded');
  });
  it('flags a symbolic TrueType that carries /Encoding', () => {
    expect(ids(buildPdfaPdf({ symbolicWithEncoding: true }))).toContain('FontEncoding');
  });
  it('flags a CID subset without /CIDSet at part 1', () => {
    expect(ids(buildPdfaPdf({ type0: true, omitCidSet: true }, 1), '1b')).toContain('FontCIDSet');
  });
  it('flags a font without a Unicode mapping at level u', () => {
    expect(ids(buildPdfaPdf({ omitToUnicode: true }, 2), '2u')).toContain('ToUnicode');
  });
  it('does NOT flag the missing Unicode mapping at level b', () => {
    expect(ids(buildPdfaPdf({ omitToUnicode: true }, 2), '2b')).not.toContain('ToUnicode');
  });
});

describe('ValidatePdfA — color/output intent', () => {
  const ids = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags device color with no output intent', () => {
    const r = ids(buildPdfaPdf({ omitOutputIntent: true, deviceColorContent: true }));
    expect(r).toContain('OutputIntent');
    expect(r).toContain('DeviceColorWithoutIntent');
  });
  it('passes device color when an output intent is present', () => {
    const r = ids(buildPdfaPdf({ deviceColorContent: true }));
    expect(r).not.toContain('OutputIntent');
    expect(r).not.toContain('DeviceColorWithoutIntent');
  });
  it('flags an ICCBased profile with a bad /N', () => {
    expect(ids(buildPdfaPdf({ badIccN: true }))).toContain('ICCBasedN');
  });
});

describe('ValidatePdfA — transparency', () => {
  const ids = (bytes: Uint8Array, level: any) =>
    open(bytes).ValidatePdfA(level).Issues.map((i) => i.rule);

  it('flags a transparency group at part 1', () => {
    expect(ids(buildPdfaPdf({ transparencyGroup: true }, 1), '1b')).toContain('Transparency');
  });
  it('flags ExtGState /ca < 1 at part 1', () => {
    expect(ids(buildPdfaPdf({ lowAlpha: true }, 1), '1b')).toContain('Transparency');
  });
  it('does NOT flag transparency at part 2', () => {
    expect(ids(buildPdfaPdf({ transparencyGroup: true, lowAlpha: true }, 2), '2b')).not.toContain('Transparency');
  });
  it('warns on a non-standard blend mode at part 2', () => {
    const issues = open(buildPdfaPdf({ nonStandardBlend: true }, 2)).ValidatePdfA('2b').Warnings;
    expect(issues.map((i) => i.rule)).toContain('BlendMode');
  });
});

describe('ValidatePdfA — annotations/forms/actions', () => {
  const ids = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags an annotation with no appearance stream', () => {
    expect(ids(buildPdfaPdf({ annotNoAp: true }))).toContain('AnnotationAppearance');
  });
  it('flags a prohibited annotation subtype', () => {
    expect(ids(buildPdfaPdf({ movieAnnot: true }))).toContain('AnnotationSubtype');
  });
  it('flags a Hidden annotation flag', () => {
    expect(ids(buildPdfaPdf({ hiddenAnnot: true }))).toContain('AnnotationFlags');
  });
  it('flags a JavaScript action', () => {
    expect(ids(buildPdfaPdf({ jsAction: true }))).toContain('Actions');
  });
  it('flags additional actions', () => {
    expect(ids(buildPdfaPdf({ additionalAction: true }))).toContain('AdditionalActions');
  });
  it('flags AcroForm /NeedAppearances', () => {
    expect(ids(buildPdfaPdf({ needAppearances: true }))).toContain('NeedAppearances');
  });
  it('flags dynamic XFA', () => {
    expect(ids(buildPdfaPdf({ xfa: true }))).toContain('XFA');
  });
});

describe('ValidatePdfA — images/content-scan', () => {
  const ids = (bytes: Uint8Array, level: any) =>
    open(bytes).ValidatePdfA(level).Issues.map((i) => i.rule);

  it('flags a JPXDecode image at part 1', () => {
    expect(ids(buildPdfaPdf({ jpxImage: true }, 1), '1b')).toContain('ImageFilter');
  });
  it('does NOT flag JPXDecode at part 2', () => {
    expect(ids(buildPdfaPdf({ jpxImage: true }, 2), '2b')).not.toContain('ImageFilter');
  });
  it('flags an LZW image filter at any part', () => {
    expect(ids(buildPdfaPdf({ inlineLzwImage: true }, 2), '2b')).toContain('ImageFilter');
  });
  it('warns on /Interpolate true', () => {
    const w = open(buildPdfaPdf({ interpolateImage: true }, 2)).ValidatePdfA('2b').Warnings;
    expect(w.map((i) => i.rule)).toContain('ImageInterpolate');
  });
  it('flags a non-standard rendering intent', () => {
    expect(ids(buildPdfaPdf({ badRenderingIntent: true }, 2), '2b')).toContain('RenderingIntent');
  });
});

describe('ValidatePdfA — level a folds in PDF/UA', () => {
  it('surfaces a UA:Tagged error for an untagged doc at 2a', () => {
    // The clean PDF/A fixture is not tagged (no /StructTreeRoot).
    const report = open(buildPdfaPdf({}, 2)).ValidatePdfA('2a');
    expect(report.Errors.map((e) => e.rule)).toContain('UA:Tagged');
    expect(report.Passed).toBe(false);
  });
  it('does NOT run UA checks at level b', () => {
    const report = open(buildPdfaPdf({}, 2)).ValidatePdfA('2b');
    expect(report.Issues.some((i) => i.rule.startsWith('UA:'))).toBe(false);
  });
});

describe('ValidatePdfA — Passed/partition semantics', () => {
  it('a warning-only document still Passes', () => {
    // /Interpolate true is a warning; nothing else fails.
    const report = open(buildPdfaPdf({ interpolateImage: true }, 2)).ValidatePdfA('2b');
    expect(report.Errors).toEqual([]);
    expect(report.Warnings.length).toBeGreaterThan(0);
    expect(report.Passed).toBe(true);
  });
});
