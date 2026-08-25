import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfxPdf } from './helpers/build-pdfx-pdf.js';
import type { PdfXLevel } from '../src/pdfxvalidate.js';
import type { PdfXConvertOptions } from '../src/pdfxconvert.js';

const convert = (bytes: Uint8Array, level: PdfXLevel = '4', opts?: PdfXConvertOptions) => {
  const doc = Document.Open(bytes);
  const report = doc.ConvertToPdfX(level, opts);
  return { doc, report, reopened: () => Document.Open(doc.Save()) };
};

describe('ConvertToPdfX — identification', () => {
  it('writes pdfxid and the /Info key, and the result validates', () => {
    const { report, reopened } = convert(
      buildPdfxPdf({ omitXmp: true, omitInfoVersion: true }, '3'), '3');
    expect(report.applied.map((a) => a.rule)).toContain('PdfxIdentification');
    expect(reopened().ValidatePdfX('3').Errors.map((e) => e.rule))
      .not.toContain('PdfxIdentification');
  });
});

describe('ConvertToPdfX — output intent', () => {
  it('adds a registered-name intent when no profile is supplied', () => {
    const { report, reopened } = convert(buildPdfxPdf({ omitOutputIntent: true }));
    expect(report.applied.map((a) => a.rule)).toContain('OutputIntent');
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('OutputIntent');
  });

  it('embeds a supplied profile', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { reopened } = convert(buildPdfxPdf({ omitOutputIntent: true }), '4',
      { iccProfile: { bytes, n: 4, identifier: 'Custom CMYK' } });
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('OutputIntent');
  });

  it('leaves an existing conformant intent alone', () => {
    const { report } = convert(buildPdfxPdf({}));
    expect(report.applied.map((a) => a.rule)).not.toContain('OutputIntent');
  });

  it('writes the external reference form at 4p', () => {
    const { reopened } = convert(buildPdfxPdf({ omitOutputIntent: true }, '4p'), '4p',
      { outputProfileRef: 'http://example.com/fogra39.icc' });
    expect(reopened().ValidatePdfX('4p').Errors.map((e) => e.rule)).not.toContain('OutputIntent');
  });
});

describe('ConvertToPdfX — structure', () => {
  it('writes /Trapped when absent', () => {
    const { report, reopened } = convert(buildPdfxPdf({ omitTrapped: true }));
    expect(report.applied.map((a) => a.rule)).toContain('Trapped');
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('Trapped');
  });

  it('honours opts.trapped', () => {
    const { reopened } = convert(buildPdfxPdf({ omitTrapped: true }), '4', { trapped: 'True' });
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('Trapped');
  });

  it('adds a /TrimBox from the /MediaBox when absent', () => {
    const { report, reopened } = convert(buildPdfxPdf({ omitTrimBox: true }));
    expect(report.applied.map((a) => a.rule)).toContain('PageGeometry');
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('PageGeometry');
  });

  it('drops /ArtBox when the page also carries /TrimBox', () => {
    const { reopened } = convert(buildPdfxPdf({ bothTrimAndArt: true }));
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('PageGeometry');
  });

  it('removes prohibited annotations and actions', () => {
    const { report, reopened } = convert(buildPdfxPdf({ movieAnnot: true, jsAction: true }));
    const applied = report.applied.map((a) => a.rule);
    expect(applied).toContain('Annotations');
    expect(applied).toContain('Actions');
    const errors = reopened().ValidatePdfX('4').Errors.map((e) => e.rule);
    expect(errors).not.toContain('Annotations');
    expect(errors).not.toContain('Actions');
  });

  it('strips transfer functions', () => {
    const { reopened } = convert(buildPdfxPdf({ transferFunction: true }));
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('TransferHalftone');
  });

  it('removes layers and embedded files at 3 but not at 4', () => {
    const at3 = convert(buildPdfxPdf({ optionalContent: true, embeddedFile: true }, '3'), '3');
    const applied = at3.report.applied.map((a) => a.rule);
    expect(applied).toContain('OptionalContent');
    expect(applied).toContain('EmbeddedFiles');

    const at4 = convert(buildPdfxPdf({ optionalContent: true, embeddedFile: true }, '4'), '4');
    expect(at4.report.applied.map((a) => a.rule)).not.toContain('OptionalContent');
  });

  it('converts a defect-ridden fixture to a passing X-4 document', () => {
    const { report } = convert(buildPdfxPdf({
      omitXmp: true, omitOutputIntent: true, omitTrapped: true, omitTrimBox: true,
      omitId: true, jsAction: true, movieAnnot: true, transferFunction: true,
    }));
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe('ConvertToPdfX — what it refuses to fix', () => {
  it('reports live transparency at 1a as unresolved rather than flattening', () => {
    const { report } = convert(buildPdfxPdf({ lowAlpha: true }, '1a'), '1a');
    expect(report.unresolved.map((e) => e.rule)).toContain('Transparency');
    expect(report.passed).toBe(false);
  });

  it('leaves an annotation inside the trim area in place', () => {
    const { report } = convert(buildPdfxPdf({ annotInsideTrim: true }));
    expect(report.unresolved.map((e) => e.rule)).toContain('Annotations');
  });

  it('reports RGB content at 1a as unresolved when convertColor is off', () => {
    const { report } = convert(buildPdfxPdf({ contentColor: 'rg' }, '1a'), '1a');
    expect(report.unresolved.map((e) => e.rule)).toContain('ProhibitedColor');
  });

  it('reports a non-embeddable font as unresolved', () => {
    const { report } = convert(buildPdfxPdf({ fontEmbedded: false }));
    expect(report.unresolved.map((e) => e.rule)).toContain('FontEmbedded');
  });
});

describe('ConvertToPdfX — opt-in color conversion', () => {
  it('leaves RGB content alone by default', () => {
    const { report } = convert(buildPdfxPdf({ contentColor: 'rg' }, '1a'), '1a');
    expect(report.applied.map((a) => a.rule)).not.toContain('ProhibitedColor');
    expect(report.unresolved.map((e) => e.rule)).toContain('ProhibitedColor');
  });

  it('rewrites rg to k when convertColor is set', () => {
    const { report, reopened } = convert(buildPdfxPdf({ contentColor: 'rg' }, '1a'), '1a',
      { convertColor: true, iccProfile: { bytes: new Uint8Array([1, 2, 3, 4]), n: 4, identifier: 'CMYK' } });
    expect(report.applied.map((a) => a.rule)).toContain('ProhibitedColor');
    expect(reopened().ValidatePdfX('1a').Errors.map((e) => e.rule)).not.toContain('ProhibitedColor');
  });

  it('maps pure red to 0 1 1 0 k', () => {
    const doc = Document.Open(buildPdfxPdf({ contentColor: 'rg' }, '1a'));
    doc.ConvertToPdfX('1a', { convertColor: true });
    const text = new TextDecoder().decode(Document.Open(doc.Save()).Pages[0].Contents);
    expect(text).toContain('0 1 1 0 k');
    expect(text).not.toContain('rg');
  });

  it('leaves a document with no RGB content untouched', () => {
    const { report } = convert(buildPdfxPdf({ contentColor: 'k' }, '1a'), '1a', { convertColor: true });
    expect(report.applied.map((a) => a.rule)).not.toContain('ProhibitedColor');
  });
});
