import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';

describe('ValidatePdfA — part 4 dispatch', () => {
  it('accepts the three part-4 levels and returns a report', () => {
    const doc = Document.Open(buildPdfaPdf({}, 2));
    for (const level of ['4', '4e', '4f'] as const) {
      const report = doc.ValidatePdfA(level);
      expect(Array.isArray(report.Issues)).toBe(true);
    }
  });

  it('never chains the PDF/UA rules at part 4 (there is no 4a level)', () => {
    const doc = Document.Open(buildPdfaPdf({}, 2));
    const rules = doc.ValidatePdfA('4').Issues.map((i) => i.rule);
    expect(rules.some((r) => r.startsWith('UA:'))).toBe(false);
  });

  it('converts to part 4 rather than refusing', () => {
    const doc = Document.Open(buildPdfaPdf({}, 4));
    const report = doc.ConvertToPdfA('4');
    expect(Array.isArray(report.applied)).toBe(true);
    expect(typeof report.passed).toBe('boolean');
  });
});

describe('ValidatePdfA — part 4 baseline', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('a clean PDF/A-4 document passes with no errors', () => {
    const report = Document.Open(buildPdfaPdf({}, 4)).ValidatePdfA('4');
    expect(report.Errors).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('flags a PDF 1.7 header at part 4 — PDF/A-4 requires 2.n, not a ceiling', () => {
    expect(errs(buildPdfaPdf({ headerVersion: '1.7' }, 4))).toContain('Version');
  });
  it('flags a catalog /Version below 2.0 at part 4', () => {
    expect(errs(buildPdfaPdf({ catalogVersion: '1.7' }, 4))).toContain('Version');
  });
  it('accepts a 2.0 header at part 4', () => {
    expect(errs(buildPdfaPdf({ headerVersion: '2.0' }, 4))).not.toContain('Version');
  });

  it('flags a present pdfaid:conformance at the base level', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: 'B' }, 4))).toContain('PdfaIdentification');
  });
  it('requires pdfaid:conformance E at 4e', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: 'E' }, 4), '4e')).not.toContain('PdfaIdentification');
    expect(errs(buildPdfaPdf({}, 4), '4e')).toContain('PdfaIdentification');
  });
  it('requires pdfaid:conformance F at 4f', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: 'F' }, 4), '4f')).not.toContain('PdfaIdentification');
  });
  it('flags a missing pdfaid:rev at part 4', () => {
    expect(errs(buildPdfaPdf({ pdfaRev: null }, 4))).toContain('PdfaIdentification');
  });
  it('flags a wrong pdfaid:rev at part 4', () => {
    expect(errs(buildPdfaPdf({ pdfaRev: '2005' }, 4))).toContain('PdfaIdentification');
  });
  it('does not require pdfaid:rev at parts 1-3', () => {
    expect(errs(buildPdfaPdf({}, 2), '2b')).not.toContain('PdfaIdentification');
  });
});

describe('ValidatePdfA — part 4 inversions (the rule must go SILENT)', () => {
  const errs = (bytes: Uint8Array, level: any) =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('/ToUnicode: required at 2u, not required at 4', () => {
    expect(errs(buildPdfaPdf({ type0: true, omitToUnicode: true }, 2), '2u')).toContain('ToUnicode');
    expect(errs(buildPdfaPdf({ type0: true, omitToUnicode: true }, 4), '4')).not.toContain('ToUnicode');
  });

  it('/CIDSet: required at 2b, no such rule at 4', () => {
    // Note both halves read Issues rather than Errors: fontCidSetRule is an
    // error only at part 1 and a warning at parts 2/3, so an Errors-only
    // assertion would find nothing at '2b' and measure the wrong thing.
    const all = (bytes: Uint8Array, level: any) =>
      Document.Open(bytes).ValidatePdfA(level).Issues.map((i) => i.rule);
    expect(all(buildPdfaPdf({ type0: true, omitCidSet: true }, 2), '2b')).toContain('FontCIDSet');
    expect(all(buildPdfaPdf({ type0: true, omitCidSet: true }, 4), '4')).not.toContain('FontCIDSet');
  });

  it('JavaScript actions: prohibited at 2b, permitted at 4', () => {
    expect(errs(buildPdfaPdf({ jsAction: true }, 2), '2b')).toContain('Actions');
    expect(errs(buildPdfaPdf({ jsAction: true }, 4), '4')).not.toContain('Actions');
  });

  it('/Info-vs-XMP consistency: reported at 2b, superseded at 4', () => {
    const opts = { infoTitle: 'A', xmpTitle: 'B' };
    const at2 = Document.Open(buildPdfaPdf(opts, 2)).ValidatePdfA('2b')
      .Issues.map((i) => i.rule);
    expect(at2).toContain('XmpInfoConsistency');
    const at4 = Document.Open(buildPdfaPdf({ ...opts, pieceInfo: true }, 4)).ValidatePdfA('4')
      .Issues.map((i) => i.rule);
    expect(at4).not.toContain('XmpInfoConsistency');
  });
});

describe('ValidatePdfA — part 4 annotations, actions and severities', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);
  const warns = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Warnings.map((e) => e.rule);

  it('prohibits /FileAttachment at part 4 but permits it at 2b', () => {
    expect(errs(buildPdfaPdf({ fileAttachAnnot: true }, 4))).toContain('AnnotationSubtype');
    expect(errs(buildPdfaPdf({ fileAttachAnnot: true }, 2), '2b')).not.toContain('AnnotationSubtype');
  });
  it('prohibits /3D at the base level and permits it at 4e', () => {
    expect(errs(buildPdfaPdf({ threeDAnnot: true }, 4))).toContain('AnnotationSubtype');
    expect(errs(buildPdfaPdf({ threeDAnnot: true, pdfaConformance: 'E' }, 4), '4e'))
      .not.toContain('AnnotationSubtype');
  });
  it('prohibits the ToggleNoView flag at part 4 but not at 2b', () => {
    expect(errs(buildPdfaPdf({ toggleNoViewAnnot: true }, 4))).toContain('AnnotationFlags');
    expect(errs(buildPdfaPdf({ toggleNoViewAnnot: true }, 2), '2b')).not.toContain('AnnotationFlags');
  });
  it('restricts /AA keys at part 4 rather than banning the dictionary', () => {
    expect(errs(buildPdfaPdf({ additionalAction: true }, 4))).toContain('AdditionalActions');
  });
  it('rejects /FFilter on a stream at part 4', () => {
    expect(errs(buildPdfaPdf({ extraStreamKeys: true }, 4))).toContain('ExternalStream');
    expect(errs(buildPdfaPdf({ extraStreamKeys: true }, 2), '2b')).not.toContain('ExternalStream');
  });
  it('raises blend mode and /Interpolate to errors at part 4', () => {
    expect(errs(buildPdfaPdf({ nonStandardBlend: true }, 4))).toContain('BlendMode');
    expect(warns(buildPdfaPdf({ nonStandardBlend: true }, 2), '2b')).toContain('BlendMode');
    expect(errs(buildPdfaPdf({ interpolateImage: true }, 4))).toContain('ImageInterpolate');
    expect(warns(buildPdfaPdf({ interpolateImage: true }, 2), '2b')).toContain('ImageInterpolate');
  });
});

describe('ValidatePdfA — part 4 catalog rules', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  // Note the fixture: /Info must hold ONLY /ModDate, or the "only /ModDate"
  // branch fires too and the case passes with the /PieceInfo test deleted.
  // Measured — the first version used a /Title and left that mutation green.
  it('flags /Info present with no catalog /PieceInfo', () => {
    expect(errs(buildPdfaPdf({ infoTitle: 'X', infoModDateOnly: true }, 4)))
      .toContain('InfoRestriction');
  });
  it('flags /Info holding anything but /ModDate', () => {
    expect(errs(buildPdfaPdf({ infoTitle: 'X', pieceInfo: true }, 4))).toContain('InfoRestriction');
  });
  it('accepts /Info holding only /ModDate beside a /PieceInfo', () => {
    expect(errs(buildPdfaPdf({ infoTitle: 'X', infoModDateOnly: true, pieceInfo: true }, 4)))
      .not.toContain('InfoRestriction');
  });
  it('does not restrict /Info at parts 1-3', () => {
    expect(errs(buildPdfaPdf({ infoTitle: 'X' }, 2), '2b')).not.toContain('InfoRestriction');
  });

  it('flags a /Perms key other than /DocMDP', () => {
    expect(errs(buildPdfaPdf({ perms: 'bad' }, 4))).toContain('Permissions');
    expect(errs(buildPdfaPdf({ perms: 'ok' }, 4))).not.toContain('Permissions');
  });
  it('flags catalog /NeedsRendering', () => {
    expect(errs(buildPdfaPdf({ needsRendering: true }, 4))).toContain('NeedsRendering');
  });
  it('flags catalog /Requirements', () => {
    expect(errs(buildPdfaPdf({ requirements: true }, 4))).toContain('Requirements');
  });
  it('flags /Names /AlternatePresentations', () => {
    expect(errs(buildPdfaPdf({ alternatePresentations: true }, 4))).toContain('AlternatePresentations');
  });
  it('flags a page /PresSteps', () => {
    expect(errs(buildPdfaPdf({ presSteps: true }, 4))).toContain('AlternatePresentations');
  });
});

describe('ValidatePdfA — part 4 graphics rules', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags ExtGState /TR and /HTO', () => {
    expect(errs(buildPdfaPdf({ trExtGState: true }, 4))).toContain('ExtGStateKeys');
    expect(errs(buildPdfaPdf({ htoExtGState: true }, 4))).toContain('ExtGStateKeys');
  });
  // The two halftone halves need SEPARATE fixtures: a dictionary carrying both
  // a bad type and a /HalftoneName passes with either branch deleted. Measured
  // — the first version did exactly that and left the type mutation green.
  it('flags a halftone that is neither type 1 nor type 5', () => {
    expect(errs(buildPdfaPdf({ badHalftone: true }, 4))).toContain('Halftone');
  });
  it('flags a /HalftoneName on an otherwise valid halftone', () => {
    expect(errs(buildPdfaPdf({ halftoneName: true }, 4))).toContain('Halftone');
  });
  it('flags image /Alternates and a bad BitsPerComponent', () => {
    expect(errs(buildPdfaPdf({ imageAlternates: true }, 4))).toContain('ImageKeys');
    expect(errs(buildPdfaPdf({ badBitsPerComponent: true }, 4))).toContain('ImageKeys');
  });
  it('flags /OPI on a Form XObject', () => {
    expect(errs(buildPdfaPdf({ formOpi: true }, 4))).toContain('FormXObjectOpi');
  });
  it('flags /DestOutputProfileRef', () => {
    expect(errs(buildPdfaPdf({ destOutputProfileRef: true }, 4))).toContain('OutputIntentKeys');
  });
  it('flags a transparency group with no /CS when there is no output intent', () => {
    expect(errs(buildPdfaPdf({ groupNoCs: true, omitOutputIntent: true, deviceColorContent: false }, 4)))
      .toContain('TransparencyBlendingSpace');
  });
  it('accepts a transparency group with no /CS when a document output intent exists', () => {
    expect(errs(buildPdfaPdf({ groupNoCs: true }, 4))).not.toContain('TransparencyBlendingSpace');
  });
  it('keeps /HTO part-4-only, because it is a PDF 2.0 key', () => {
    // This case asserted "applies none of these at parts 1-3" until pjy7, which
    // is the decision that issue reverses: ISO 19005-1/-2/-3 carry the transfer
    // function and image key tests too, and 72nc.1 gated them only because
    // widening changes ConvertToPdfA's outcomes. The cross-part pairs live in
    // test/pdfa-backport.test.ts now; what remains part-4-only is /HTO.
    expect(errs(buildPdfaPdf({ htoExtGState: true }, 2), '2b')).not.toContain('ExtGStateKeys');
    expect(errs(buildPdfaPdf({ htoExtGState: true }, 4))).toContain('ExtGStateKeys');
  });
});

describe('ValidatePdfA — part 4 ToUnicode contents, appearances, OC', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags a ToUnicode CMap mapping to U+0000', () => {
    expect(errs(buildPdfaPdf({ type0: true, badToUnicode: true }, 4))).toContain('ToUnicodeContent');
  });
  it('accepts a well-formed ToUnicode CMap', () => {
    expect(errs(buildPdfaPdf({ type0: true }, 4))).not.toContain('ToUnicodeContent');
  });
  it('does not apply the content rule at parts 1-3', () => {
    expect(errs(buildPdfaPdf({ type0: true, badToUnicode: true }, 2), '2b'))
      .not.toContain('ToUnicodeContent');
  });
  it('flags an /AP holding more than /N', () => {
    expect(errs(buildPdfaPdf({ apWithDown: true }, 4))).toContain('AppearanceKeys');
  });
  it('flags a Widget annotation carrying /A', () => {
    expect(errs(buildPdfaPdf({ widgetWithAction: true }, 4))).toContain('WidgetAction');
  });
  it('flags an optional-content configuration with no /Name', () => {
    expect(errs(buildPdfaPdf({ ocConfigNoName: true }, 4))).toContain('OcConfig');
  });
});

describe('ValidatePdfA — part 4 embedded files', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);
  const warns = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Warnings.map((e) => e.rule);

  // Three fixtures, not one: a spec missing /UF, /AFRelationship AND /Subtype
  // still reports with any single branch deleted, so each branch needs a
  // fixture that omits exactly one thing. Measured — the all-missing case left
  // both the key-list and the MIME mutations green.
  it('flags a file specification missing everything', () => {
    expect(errs(buildPdfaPdf({ embeddedFile: 'bare' }, 4))).toContain('EmbeddedFileSpec');
  });
  it('flags a file specification missing only /UF', () => {
    expect(errs(buildPdfaPdf({ embeddedFile: 'noUf' }, 4))).toContain('EmbeddedFileSpec');
  });
  it('flags an embedded stream missing only its /Subtype MIME type', () => {
    expect(errs(buildPdfaPdf({ embeddedFile: 'noMime' }, 4))).toContain('EmbeddedFileSpec');
  });
  it('accepts a complete file specification', () => {
    expect(errs(buildPdfaPdf({ embeddedFile: 'full' }, 4))).not.toContain('EmbeddedFileSpec');
  });
  it('4f requires an /EmbeddedFiles name tree', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: 'F' }, 4), '4f')).toContain('EmbeddedFilesRequired');
    expect(errs(buildPdfaPdf({ pdfaConformance: 'F', embeddedFile: 'full' }, 4), '4f'))
      .not.toContain('EmbeddedFilesRequired');
  });
  it('base 4 does not require embedded files', () => {
    expect(errs(buildPdfaPdf({}, 4))).not.toContain('EmbeddedFilesRequired');
  });
  it('warns that an embedded file conformance is unverified at 4, silent at 4f', () => {
    expect(warns(buildPdfaPdf({ embeddedFile: 'full' }, 4))).toContain('EmbeddedFileConformance');
    expect(warns(buildPdfaPdf({ embeddedFile: 'full', pdfaConformance: 'F' }, 4), '4f'))
      .not.toContain('EmbeddedFileConformance');
  });
});

describe('ValidatePdfA — an empty pdfaid attribute is present, not absent (ugxr)', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  // ISO 19005-4 6.7.3-3 spells the base conformance by genuine ABSENCE. An
  // empty attribute is a present key with an invalid value, and pdfaIdValue's
  // `+` made the two indistinguishable - so a file declaring conformance=""
  // passed. Reached during 72nc.2's mutation sweep, where a build writing that
  // very packet reddened nothing.
  it('flags an EMPTY pdfaid:conformance at the base level', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: '' }, 4))).toContain('PdfaIdentification');
  });

  it('still accepts a genuinely absent conformance at the base level', () => {
    expect(errs(buildPdfaPdf({}, 4))).not.toContain('PdfaIdentification');
  });

  it('flags an empty pdfaid:rev, which is not the same as a missing one', () => {
    expect(errs(buildPdfaPdf({ pdfaRev: '' }, 4))).toContain('PdfaIdentification');
  });

  it('still flags an empty conformance at parts 1-3, where one is required', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: '' }, 2), '2b')).toContain('PdfaIdentification');
  });
});
