import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/index.js';
import type { PdfObject } from '../src/types.js';
import { srgbIcc } from '../src/srgb.js';
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

// ISO 19005-1 6.2.3.3 asks a narrower question than "is there an intent": is
// the intent's profile a profile OF THE SPACE the content uses. DeviceCMYK is
// permitted only under a CMYK intent, DeviceRGB only under an RGB one;
// DeviceGray is satisfied by either.
describe('ValidatePdfA — device colour against the output intent space', () => {
  const ids = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);
  const colour = (deviceColorSpace: 'RGB' | 'CMYK' | 'Gray', iccSpace: 'RGB' | 'CMYK' | 'GRAY') =>
    ids(buildPdfaPdf({ deviceColorContent: true, deviceColorSpace, iccSpace }));

  it('flags CMYK content under an RGB intent', () => {
    expect(colour('CMYK', 'RGB')).toContain('DeviceColorWithoutIntent');
  });
  it('passes CMYK content under a CMYK intent', () => {
    expect(colour('CMYK', 'CMYK')).not.toContain('DeviceColorWithoutIntent');
  });
  it('flags RGB content under a CMYK intent', () => {
    expect(colour('RGB', 'CMYK')).toContain('DeviceColorWithoutIntent');
  });
  it('passes RGB content under an RGB intent', () => {
    expect(colour('RGB', 'RGB')).not.toContain('DeviceColorWithoutIntent');
  });
  it('passes Gray content under an RGB intent', () => {
    expect(colour('Gray', 'RGB')).not.toContain('DeviceColorWithoutIntent');
  });
  it('passes Gray content under a CMYK intent', () => {
    expect(colour('Gray', 'CMYK')).not.toContain('DeviceColorWithoutIntent');
  });
  it('flags CMYK content under a Gray intent', () => {
    expect(colour('CMYK', 'GRAY')).toContain('DeviceColorWithoutIntent');
  });

  it('names the space it wanted and the space it found', () => {
    const errs = open(buildPdfaPdf({ deviceColorSpace: 'CMYK', iccSpace: 'RGB' }))
      .ValidatePdfA('2b').Errors.filter((e) => e.rule === 'DeviceColorWithoutIntent');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('DeviceCMYK');
    expect(errs[0]!.message).toContain('RGB');
  });

  // A profile we cannot read cannot be checked, so the rule falls back to
  // today's answer: an intent exists, device colour is covered. This is what
  // keeps every fixture written before ixxw.1 — all of which carry a 4-byte
  // blob where a profile should be — reporting exactly as it did.
  it('does not flag when the intent profile is unreadable', () => {
    expect(ids(buildPdfaPdf({ deviceColorSpace: 'CMYK' }))).not.toContain('DeviceColorWithoutIntent');
  });

  it('still flags device colour when there is no intent at all', () => {
    expect(ids(buildPdfaPdf({ omitOutputIntent: true, deviceColorSpace: 'CMYK' })))
      .toContain('DeviceColorWithoutIntent');
  });

  // The space is read from the PROFILE HEADER, never from the stream dict's
  // /N. Both are legal answers to "how many components", and they agree in
  // every real file — which is exactly why this needs its own fixture: with
  // them agreeing, deriving the space from /N instead reddens NOTHING, so the
  // decision would otherwise be held by reasoning alone.
  it('reads the header, not /N, when the two disagree (header permits)', () => {
    expect(ids(buildPdfaPdf({ deviceColorSpace: 'CMYK', iccSpace: 'CMYK', iccN: 3 })))
      .not.toContain('DeviceColorWithoutIntent');
  });
  it('reads the header, not /N, when the two disagree (header refuses)', () => {
    expect(ids(buildPdfaPdf({ deviceColorSpace: 'CMYK', iccSpace: 'RGB', iccN: 4 })))
      .toContain('DeviceColorWithoutIntent');
  });

  // The fixture builder's 256-byte header is one we hand-wrote for these
  // cases, so it cannot catch a wrong byte offset or a real profile's padding:
  // it declares what it declares because we put it there. These two swap in
  // profiles nobody wrote for this test — the vendored sRGB blob and the
  // synthetic CMYK one `test/fixtures/icc/` already carries for icclut.ts —
  // and drive the same rule end to end.
  const withRealProfile = (
    deviceColorSpace: 'RGB' | 'CMYK' | 'Gray', profile: Uint8Array, n: number,
  ): string[] => {
    const doc = open(buildPdfaPdf({ deviceColorContent: true, deviceColorSpace }));
    const ois = doc.resolve(doc.catalog().get('OutputIntents')) as PdfObject[];
    const oi = doc.resolve(ois[0]) as Map<string, PdfObject>;
    // The profile object is REPLACED rather than the dict entry repointed at a
    // direct stream: pdfaOutputIntentProfile only counts a /DestOutputProfile
    // that is a ref, so a direct one reads as no intent at all and the case
    // would measure the no-intent branch instead of the space check.
    const { num } = oi.get('DestOutputProfile') as { num: number };
    doc.replaceObject(num, {
      kind: 'stream', dict: new Map<string, PdfObject>([['N', n]]), raw: profile,
    });
    return doc.ValidatePdfA('2b').Errors.map((e) => e.rule);
  };
  const realCmyk = new Uint8Array(
    readFileSync(new URL('./fixtures/icc/synthetic-cmyk.icc', import.meta.url)));

  it('flags CMYK content under the real sRGB profile', () => {
    expect(withRealProfile('CMYK', srgbIcc(), 3)).toContain('DeviceColorWithoutIntent');
  });
  it('passes CMYK content under a real CMYK profile', () => {
    expect(withRealProfile('CMYK', realCmyk, 4)).not.toContain('DeviceColorWithoutIntent');
  });
  it('passes RGB content under the real sRGB profile', () => {
    expect(withRealProfile('RGB', srgbIcc(), 3)).not.toContain('DeviceColorWithoutIntent');
  });
  it('flags RGB content under a real CMYK profile', () => {
    expect(withRealProfile('RGB', realCmyk, 4)).toContain('DeviceColorWithoutIntent');
  });
});

// 32000-1 7.3.8 says every stream shall be indirect, so a /DestOutputProfile
// written inline is malformed — but this parser accepts it (parseDictOrStream
// runs for nested dicts too), and a document we did not write is exactly the
// population leniency exists for. The intent is plainly there; reporting it
// absent is a false positive on a file whose meaning is not in doubt.
describe('ValidatePdfA — an inline /DestOutputProfile is still an output intent', () => {
  const ids = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('does not report a missing intent for an inline profile', () => {
    const r = ids(buildPdfaPdf({ directOutputProfile: true, iccSpace: 'RGB' }));
    expect(r).not.toContain('OutputIntent');
    expect(r).not.toContain('DeviceColorWithoutIntent');
  });

  // The whole point of counting it as an intent is that its space is then
  // read, so these drive ixxw.1's rule through the inline shape.
  // Asserted on the MESSAGE, not the rule id: with the intent read as absent
  // this same id fires from the no-intent branch, so the id alone passes
  // today and measures nothing.
  it('reads an inline profile’s space: CMYK content under an inline RGB profile', () => {
    const errs = open(buildPdfaPdf({
      directOutputProfile: true, iccSpace: 'RGB', deviceColorSpace: 'CMYK',
    })).ValidatePdfA('2b').Errors.filter((e) => e.rule === 'DeviceColorWithoutIntent');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('DeviceCMYK');
    expect(errs[0]!.message).toContain('RGB profile');
  });
  it('reads an inline profile’s space: CMYK content under an inline CMYK profile', () => {
    expect(ids(buildPdfaPdf({
      directOutputProfile: true, iccSpace: 'CMYK', deviceColorSpace: 'CMYK',
    }))).not.toContain('DeviceColorWithoutIntent');
  });

  // The mirror defect: two inline profiles both landed on one sentinel, so a
  // document naming two DIFFERENT output conditions read as naming one.
  it('reports two different inline profiles as multiple', () => {
    // Again on the message: 'OutputIntent' is also what the no-intent branch
    // reports, which is exactly what this document did before the fix.
    const errs = open(buildPdfaPdf({ twoDirectProfiles: true, iccSpace: 'RGB' }))
      .ValidatePdfA('2b').Errors.filter((e) => e.rule === 'OutputIntent');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain('Multiple');
  });
  it('still does NOT report two intents sharing one referenced profile', () => {
    expect(ids(buildPdfaPdf({ twoPdfaOutputIntents: true }))).not.toContain('OutputIntent');
  });

  // The third consumer: 6.2.10-2 bites only when the document declares no
  // PDF/A output intent, so an inline one must satisfy it too.
  it('an inline profile satisfies the transparency blending-space rule', () => {
    expect(ids(buildPdfaPdf({ directOutputProfile: true, iccSpace: 'RGB', groupNoCs: true })))
      .not.toContain('TransparencyBlendingSpace');
  });
  it('but a document with no intent at all still reports it', () => {
    expect(ids(buildPdfaPdf({ omitOutputIntent: true, groupNoCs: true })))
      .toContain('TransparencyBlendingSpace');
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
