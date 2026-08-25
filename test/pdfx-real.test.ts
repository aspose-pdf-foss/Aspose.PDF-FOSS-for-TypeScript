import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/index.js';

/** Real-world PDF/X-3, produced by Ghostscript's own `-dPDFX` path. See
 *  fixtures/pdfx/PROVENANCE.md. The builders in helpers/build-pdfx-pdf.ts
 *  cannot catch what this covers: our validator and our builder agreeing with
 *  each other and both disagreeing with ISO 15930. */
const fixture = (n: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/pdfx/${n}`, import.meta.url)));

describe('ValidatePdfX — real-world Ghostscript output', () => {
  it('accepts a conformant PDF/X-3 with no errors', () => {
    const report = Document.Open(fixture('ghostscript-x3.pdf')).ValidatePdfX('3');
    expect(report.Errors).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('accepts the 2002 vintage of the X-3 identification string', () => {
    // Ghostscript writes /Info /GTS_PDFXVersion (PDF/X-3:2002) per ISO 15930-3;
    // ISO 15930-6 later defined PDF/X-3:2003. Both identify PDF/X-3.
    const doc = Document.Open(fixture('ghostscript-x3.pdf'));
    const info = doc.resolve(doc.trailer.get('Info')) as Map<string, any>;
    const v = doc.resolve(info.get('GTS_PDFXVersion')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(v.bytes)).toBe('PDF/X-3:2002');
  });

  it('identifies X-3 from /Info without requiring an XMP pdfxid packet', () => {
    // XMP-based identification is PDF/X-4's mechanism (ISO 15930-7); the
    // legacy levels identify through the /Info key alone.
    const doc = Document.Open(fixture('ghostscript-x3.pdf'));
    expect(doc.GetXmp().raw).toBeUndefined();
    expect(doc.ValidatePdfX('3').Errors.map((e) => e.rule)).not.toContain('PdfxIdentification');
  });
});

describe('ValidatePdfX — real-world PDF/X-1a', () => {
  it('accepts a conformant PDF/X-1a with no errors', () => {
    const report = Document.Open(fixture('ghostscript-x1a.pdf')).ValidatePdfX('1a');
    expect(report.Errors).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('accepts the 2001 vintage of the X-1a identification string', () => {
    // The counterpart to the X-3 vintage split: ISO 15930-1:2001 defines
    // PDF/X-1a:2001, ISO 15930-4:2003 defines PDF/X-1a:2003. Until this
    // fixture the :2001 arm of xVersionStrings('1a') was reasoned from the
    // standard, never witnessed.
    const doc = Document.Open(fixture('ghostscript-x1a.pdf'));
    const info = doc.resolve(doc.trailer.get('Info')) as Map<string, any>;
    const v = doc.resolve(info.get('GTS_PDFXVersion')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(v.bytes)).toBe('PDF/X-1a:2001');
  });
});

describe('ValidatePdfX — real-world PDF/X-4', () => {
  it('accepts a conformant PDF/X-4 with no errors', () => {
    const report = Document.Open(fixture('ghostscript-x4.pdf')).ValidatePdfX('4');
    expect(report.Errors).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('identifies X-4 through the XMP pdfxid packet', () => {
    // The mirror of the X-3 case: at X-4 the XMP packet is the identification
    // mechanism (ISO 15930-7 §6.2), and it is present here.
    const doc = Document.Open(fixture('ghostscript-x4.pdf'));
    expect(doc.GetXmp().raw).toBeDefined();
    expect(doc.ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('PdfxIdentification');
  });
});

describe('ValidatePdfX — registered characterization names', () => {
  // Both fixtures omit /DestOutputProfile, so outputIntentRule runs past the
  // embedded-stream branch and reaches the registered-name allowance — the
  // branch the default ConvertToPdfX path rests on, and which the profile-
  // carrying fixtures above never touch. They differ only in the spelling of
  // /OutputConditionIdentifier.

  it('accepts a registered name with no embedded profile', () => {
    const doc = Document.Open(fixture('ghostscript-x3-registered.pdf'));
    const report = doc.ValidatePdfX('3');
    expect(report.Errors).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it("rejects Ghostscript's unregistered 'CGATS TR001' spelling", () => {
    // The ICC registry lists 'CGATS TR 001' with a space; Ghostscript's own
    // PDFX_def.ps sample writes 'CGATS TR001' without one. With a profile
    // embedded that is moot, but on its own it is not a registered name.
    const doc = Document.Open(fixture('ghostscript-x3-noicc.pdf'));
    const errs = doc.ValidatePdfX('3').Errors.filter((e) => e.rule === 'OutputIntent');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('CGATS TR001');
  });
});
