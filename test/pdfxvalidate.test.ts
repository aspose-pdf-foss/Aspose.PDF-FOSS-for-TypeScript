import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfxPdf } from './helpers/build-pdfx-pdf.js';
import type { PdfXLevel } from '../src/pdfxvalidate.js';

const open = (bytes: Uint8Array) => Document.Open(bytes);
const rules = (bytes: Uint8Array, level: PdfXLevel = '4') =>
  open(bytes).ValidatePdfX(level).Errors.map((e) => e.rule);

describe('ValidatePdfX — harness', () => {
  it('clean X-4 document passes with zero errors and no warnings', () => {
    const report = open(buildPdfxPdf({}, '4')).ValidatePdfX('4');
    expect(report.Errors).toEqual([]);
    expect(report.Warnings).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('clean X-1a, X-3 and X-4p documents pass', () => {
    expect(open(buildPdfxPdf({}, '1a')).ValidatePdfX('1a').Errors).toEqual([]);
    expect(open(buildPdfxPdf({}, '3')).ValidatePdfX('3').Errors).toEqual([]);
    expect(open(buildPdfxPdf({}, '4p')).ValidatePdfX('4p').Errors).toEqual([]);
  });
});

describe('ValidatePdfX — identification', () => {
  it('flags a missing XMP packet', () => {
    expect(rules(buildPdfxPdf({ omitXmp: true }))).toContain('PdfxIdentification');
  });
  it('flags a GTS_PDFXVersion that disagrees with the requested level', () => {
    expect(rules(buildPdfxPdf({ pdfxVersion: 'PDF/X-1a:2003' }, '4'), '4'))
      .toContain('PdfxIdentification');
  });
  it('flags a missing /Info /GTS_PDFXVersion at 1a but not at 4', () => {
    expect(rules(buildPdfxPdf({ omitInfoVersion: true }, '1a'), '1a'))
      .toContain('PdfxIdentification');
    expect(rules(buildPdfxPdf({ omitInfoVersion: true }, '4'), '4'))
      .not.toContain('PdfxIdentification');
  });
});

describe('ValidatePdfX — output intent', () => {
  it('flags a missing output intent', () => {
    expect(rules(buildPdfxPdf({ omitOutputIntent: true }))).toContain('OutputIntent');
  });
  it('flags a non-GTS_PDFX intent subtype', () => {
    expect(rules(buildPdfxPdf({ intentSubtype: 'GTS_PDFA1' }))).toContain('OutputIntent');
  });
  it('flags two PDF/X output intents', () => {
    expect(rules(buildPdfxPdf({ twoIntents: true }))).toContain('OutputIntent');
  });
  it('accepts a registered characterization name with no embedded profile', () => {
    expect(rules(buildPdfxPdf({ registeredNameOnly: true }))).not.toContain('OutputIntent');
  });
  it('flags an unregistered identifier with no embedded profile', () => {
    expect(rules(buildPdfxPdf({ unregisteredNameOnly: true }))).toContain('OutputIntent');
  });
  // The registry gains entries over time and our set was transcribed once, so a
  // conformant name added later reads as unregistered. These are the entries the
  // ICC registry listed that our first transcription missed; CGATS21-2 (CRPC) is
  // the current US/international reference set, so it is live, not historical.
  it.each([
    'CGATS21-2-CRPC1', 'CGATS21-2-CRPC2', 'CGATS21-2-CRPC3', 'CGATS21-2-CRPC4',
    'CGATS21-2-CRPC5', 'CGATS21-2-CRPC6', 'CGATS21-2-CRPC7',
    'APTEC_CTV_3', 'APTEC_CTV_4', 'APTEC_CTV_5', 'APTEC_CTV_6', 'APTEC_CTV_7', 'APTEC_CTV_8',
    'APTEC Coated CardBoard', 'APTEC CCNB',
    'JCS2011', 'JC200104', 'FOGRA48', 'FOGRA49', 'FOGRA50', 'FOGRA53', 'FOGRA54',
  ])('accepts registered characterization name %s', (name) => {
    expect(rules(buildPdfxPdf({ registeredNameOnly: true, conditionName: name })))
      .not.toContain('OutputIntent');
  });
  it('accepts an external profile reference at 4p but not at 4', () => {
    expect(rules(buildPdfxPdf({ externalProfileRef: true }, '4p'), '4p'))
      .not.toContain('OutputIntent');
    expect(rules(buildPdfxPdf({ externalProfileRef: true }, '4'), '4'))
      .toContain('OutputIntent');
  });
});

describe('ValidatePdfX — structure', () => {
  it('flags a missing /Info /Trapped', () => {
    expect(rules(buildPdfxPdf({ omitTrapped: true }))).toContain('Trapped');
  });
  it('flags /Trapped /Unknown', () => {
    expect(rules(buildPdfxPdf({ trapped: 'Unknown' }))).toContain('Trapped');
  });
  it('accepts /Trapped /True', () => {
    expect(rules(buildPdfxPdf({ trapped: 'True' }))).not.toContain('Trapped');
  });
  it('flags a page with neither /TrimBox nor /ArtBox', () => {
    expect(rules(buildPdfxPdf({ omitTrimBox: true }))).toContain('PageGeometry');
  });
  it('flags a page carrying both /TrimBox and /ArtBox', () => {
    expect(rules(buildPdfxPdf({ bothTrimAndArt: true }))).toContain('PageGeometry');
  });
  it('flags a /BleedBox outside the /MediaBox', () => {
    expect(rules(buildPdfxPdf({ bleedOutsideMedia: true }))).toContain('PageGeometry');
  });
  it('flags an over-ceiling version at 1a but not at 4', () => {
    expect(rules(buildPdfxPdf({ headerVersion: '1.6' }, '1a'), '1a')).toContain('Version');
    expect(rules(buildPdfxPdf({ headerVersion: '1.6' }, '4'), '4')).not.toContain('Version');
  });
  it('flags an LZW filter', () => {
    expect(rules(buildPdfxPdf({ lzwStream: true }))).toContain('Filters');
  });
  it('flags JPXDecode at 3 but not at 4', () => {
    expect(rules(buildPdfxPdf({ jpxImage: true }, '3'), '3')).toContain('Filters');
    expect(rules(buildPdfxPdf({ jpxImage: true }, '4'), '4')).not.toContain('Filters');
  });
  it('flags a missing /ID', () => {
    expect(rules(buildPdfxPdf({ omitId: true }))).toContain('FileID');
  });
  it('flags a non-embedded font', () => {
    expect(rules(buildPdfxPdf({ fontEmbedded: false }))).toContain('FontEmbedded');
  });
  it('flags an encrypted document', () => {
    // Round-trip through real encryption: a forged /Encrypt would make
    // Document.Open reject the file outright.
    const encrypted = Document.Open(buildPdfxPdf({})).Save({ encrypt: { userPassword: '' } });
    expect(Document.Open(encrypted).ValidatePdfX('4').Errors.map((e) => e.rule))
      .toContain('Encryption');
  });
});

describe('ValidatePdfX — color', () => {
  it('flags DeviceRGB content at 1a but not at 3 or 4', () => {
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '1a'), '1a')).toContain('ProhibitedColor');
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '3'), '3')).not.toContain('ProhibitedColor');
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '4'), '4')).not.toContain('ProhibitedColor');
  });
  it('flags an ICCBased space at 1a', () => {
    expect(rules(buildPdfxPdf({ iccBasedSpace: true }, '1a'), '1a')).toContain('ProhibitedColor');
  });
  it('flags DeviceRGB under a CMYK output intent at 3 and 4', () => {
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '3'), '3')).toContain('ColorWithoutIntent');
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '4'), '4')).toContain('ColorWithoutIntent');
  });
  it('accepts DeviceCMYK under a CMYK output intent', () => {
    expect(rules(buildPdfxPdf({ contentColor: 'k' }, '4'), '4')).not.toContain('ColorWithoutIntent');
  });
  it('accepts DeviceGray under any intent', () => {
    expect(rules(buildPdfxPdf({ contentColor: 'g' }, '4'), '4')).not.toContain('ColorWithoutIntent');
  });
  it('flags an RGB output-intent profile at 1a', () => {
    expect(rules(buildPdfxPdf({ iccN: 3 }, '1a'), '1a')).toContain('OutputIntentColor');
  });
});

describe('ValidatePdfX — transparency and layers', () => {
  it('flags a transparency group at 1a and 3 but not at 4', () => {
    expect(rules(buildPdfxPdf({ transparencyGroup: true }, '1a'), '1a')).toContain('Transparency');
    expect(rules(buildPdfxPdf({ transparencyGroup: true }, '3'), '3')).toContain('Transparency');
    expect(rules(buildPdfxPdf({ transparencyGroup: true }, '4'), '4')).not.toContain('Transparency');
  });
  it('flags ExtGState /ca below 1 at 3', () => {
    expect(rules(buildPdfxPdf({ lowAlpha: true }, '3'), '3')).toContain('Transparency');
  });
  it('flags optional content at 3 but not at 4', () => {
    expect(rules(buildPdfxPdf({ optionalContent: true }, '3'), '3')).toContain('OptionalContent');
    expect(rules(buildPdfxPdf({ optionalContent: true }, '4'), '4')).not.toContain('OptionalContent');
  });
  it('flags an embedded file at 1a but not at 4', () => {
    expect(rules(buildPdfxPdf({ embeddedFile: true }, '1a'), '1a')).toContain('EmbeddedFiles');
    expect(rules(buildPdfxPdf({ embeddedFile: true }, '4'), '4')).not.toContain('EmbeddedFiles');
  });
});

describe('ValidatePdfX — transfer functions and halftones', () => {
  it('flags an ExtGState transfer function', () => {
    expect(rules(buildPdfxPdf({ transferFunction: true }))).toContain('TransferHalftone');
  });
  it('flags a halftone of a prohibited type', () => {
    expect(rules(buildPdfxPdf({ badHalftone: true }))).toContain('TransferHalftone');
  });
  it('does not report absent keys on an ExtGState that has other entries', () => {
    // doc.resolve(undefined) returns null, not undefined, so a rule that
    // resolves before checking presence fires on every absent key. This
    // ExtGState carries only /HT: it must trip TransferHalftone exactly once
    // (the halftone) and must not trip /SMask transparency at all.
    const issues = open(buildPdfxPdf({ badHalftone: true }, '3')).ValidatePdfX('3').Issues;
    expect(issues.filter((i) => i.rule === 'TransferHalftone')).toHaveLength(1);
    expect(issues.map((i) => i.rule)).not.toContain('Transparency');
  });
});

describe('ValidatePdfX — annotations and actions', () => {
  it('flags an annotation overlapping the trim area', () => {
    expect(rules(buildPdfxPdf({ annotInsideTrim: true }))).toContain('Annotations');
  });
  it('flags a prohibited annotation subtype placed outside the trim area', () => {
    // /Rect [0 0 5 5] does not overlap /BleedBox [5 5 195 195], so this can
    // only trip on the subtype.
    expect(rules(buildPdfxPdf({ movieAnnot: true }))).toContain('Annotations');
  });
  it('flags a JavaScript action', () => {
    expect(rules(buildPdfxPdf({ jsAction: true }))).toContain('Actions');
  });
});
