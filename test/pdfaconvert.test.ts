import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import type { PdfDict, PdfObject } from '../src/types.js';
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

describe('ConvertToPdfA — part 4 identification and version', () => {
  const errs = (d: Document, lvl: any) => d.ValidatePdfA(lvl).Errors.map((e) => e.rule);

  it('writes pdfaid part 4 with rev 2020 and NO conformance at the base level', () => {
    const doc = open(buildPdfaPdf({ headerVersion: '1.7' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('PdfaIdentification');
    const xmp = doc.GetXmp();
    expect(xmp.pdfaPart).toBe(4);
    expect(xmp.pdfaRev).toBe(2020);
    expect(xmp.pdfaConformance).toBeUndefined();  // 6.7.3-3: spelled by ABSENCE
    // Asserted on the PACKET, and it has to be: both pdfaIdValue and readXmp
    // match `[^"']+`, so a written pdfaid:conformance="" reads back as ABSENT
    // to the validator and to GetXmp alike. The field assertion above passes
    // either way; only the bytes can tell the two apart. (Measured - the
    // conformance mutation reddened nothing until this line existed.)
    expect(xmp.raw ?? '').not.toContain('pdfaid:conformance');
    expect(errs(doc, '4')).not.toContain('PdfaIdentification');
  });

  it('writes conformance E at 4e and F at 4f', () => {
    const e = open(buildPdfaPdf({}, 4));
    e.ConvertToPdfA('4e');
    expect(e.GetXmp().pdfaConformance).toBe('E');
    expect(errs(e, '4e')).not.toContain('PdfaIdentification');

    const f = open(buildPdfaPdf({ embeddedFile: 'full' }, 4));
    f.ConvertToPdfA('4f');
    expect(f.GetXmp().pdfaConformance).toBe('F');
    expect(errs(f, '4f')).not.toContain('PdfaIdentification');
  });

  it('deletes a stray pdfaid:conformance when converting to the base level', () => {
    const doc = open(buildPdfaPdf({ pdfaConformance: 'B' }, 4));
    doc.ConvertToPdfA('4');
    expect(doc.GetXmp().pdfaConformance).toBeUndefined();
    expect(errs(doc, '4')).not.toContain('PdfaIdentification');
  });

  it('declares PDF 2.0, so the saved header satisfies the part-4 version rule', () => {
    const doc = open(buildPdfaPdf({ headerVersion: '1.7' }, 4));
    doc.ConvertToPdfA('4');
    const saved = doc.Save();
    expect(new TextDecoder('latin1').decode(saved.subarray(0, 8))).toBe('%PDF-2.0');
    expect(open(saved).ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('Version');
  });

  it('leaves the part 1 and part 2 version ceilings alone', () => {
    const d1 = open(buildPdfaPdf({ headerVersion: '1.4' }, 1));
    d1.ConvertToPdfA('1b');
    expect(new TextDecoder('latin1').decode(d1.Save().subarray(0, 8))).toBe('%PDF-1.4');
    const d2 = open(buildPdfaPdf({}, 2));
    d2.ConvertToPdfA('2b');
    expect(new TextDecoder('latin1').decode(d2.Save().subarray(0, 8))).toBe('%PDF-1.7');
  });
});

describe('ConvertToPdfA — part 4 /Info', () => {
  const rules = (d: Document, lvl: any = '4') => d.ValidatePdfA(lvl).Errors.map((e) => e.rule);

  it('removes /Info when the catalog has no /PieceInfo, having mirrored it into XMP first', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Real Title' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('InfoRestriction');
    expect(doc.trailer.get('Info')).toBeUndefined();
    // The ordering invariant: identificationPass must have run FIRST, or this
    // title is gone. A fixture whose /Info is already absent measures nothing.
    expect(doc.GetXmp().title).toBe('Real Title');
    expect(rules(doc)).not.toContain('InfoRestriction');
  });

  it('reduces /Info to /ModDate when the catalog has a /PieceInfo', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Real Title', infoWithModDate: true, pieceInfo: true }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('InfoRestriction');
    expect(doc.trailer.get('Info')).toBeDefined();
    const meta = doc.GetMetadata();
    expect(meta.title).toBeUndefined();
    expect(meta.modDate).toBeDefined();
    expect(doc.GetXmp().title).toBe('Real Title');
    expect(rules(doc)).not.toContain('InfoRestriction');
  });

  it('removes the empty /Info that writing identification XMP itself creates', () => {
    // SetXmp calls ensureInfo() unconditionally, so identificationPass creates
    // an /Info even for a document that had none - and an /Info with no
    // /PieceInfo is an InfoRestriction error however empty it is.
    const doc = open(buildPdfaPdf({}, 4));
    expect(doc.trailer.get('Info')).toBeUndefined();
    doc.ConvertToPdfA('4');
    expect(doc.trailer.get('Info')).toBeUndefined();
    expect(rules(doc)).not.toContain('InfoRestriction');
  });

  it('preserve: [info] keeps /Info and reports it unresolved', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Real Title' }, 4));
    const report = doc.ConvertToPdfA('4', { preserve: ['info'] });
    expect(report.applied.map((a) => a.rule)).not.toContain('InfoRestriction');
    expect(doc.trailer.get('Info')).toBeDefined();
    expect(report.unresolved.map((i) => i.rule)).toContain('InfoRestriction');
  });

  it('leaves /Info alone at parts 1-3', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Keep me' }, 2));
    doc.ConvertToPdfA('2b');
    expect(doc.GetMetadata().title).toBe('Keep me');
  });
});

describe('ConvertToPdfA — part 4 catalog', () => {
  const conv = (opts: any, lvl: any = '4') => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };

  it('removes catalog /NeedsRendering', () => {
    const r = conv({ needsRendering: true });
    expect(r.applied).toContain('NeedsRendering');
    expect(r.errors).not.toContain('NeedsRendering');
  });

  it('removes catalog /Requirements', () => {
    const r = conv({ requirements: true });
    expect(r.applied).toContain('Requirements');
    expect(r.errors).not.toContain('Requirements');
  });

  it('removes /Names /AlternatePresentations and page /PresSteps', () => {
    const r = conv({ alternatePresentations: true, presSteps: true });
    expect(r.applied.filter((x) => x === 'AlternatePresentations').length).toBe(2);
    expect(r.errors).not.toContain('AlternatePresentations');
  });

  it('removes a /Perms key other than /DocMDP and keeps /DocMDP', () => {
    const r = conv({ perms: 'bad' });
    expect(r.applied).toContain('Permissions');
    expect(r.errors).not.toContain('Permissions');
    const perms = r.doc.resolve(r.doc.catalog().get('Perms')) as PdfDict;
    expect([...perms.keys()]).toEqual(['DocMDP']);
  });

  it('leaves the part-4-only catalog keys alone at parts 1-3', () => {
    // /NeedsRendering was in this list until pjy7: ISO 19005-2/-3 6.4.2-2
    // prohibits it too, so the pass now removes it from part 2 up. The other
    // three are PDF 2.0-era restrictions with no counterpart in the older
    // profiles, and they stay.
    const doc = open(buildPdfaPdf({ needsRendering: true, requirements: true, perms: 'bad' }, 2));
    doc.ConvertToPdfA('2b');
    expect(doc.catalog().get('NeedsRendering')).toBeUndefined();
    expect(doc.catalog().get('Requirements')).toBeDefined();
    expect(doc.catalog().get('Perms')).toBeDefined();
  });
});

describe('ConvertToPdfA — part 4 graphics', () => {
  const conv = (opts: any, lvl: any = '4') => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };
  const extGState = (doc: Document, key: string): PdfDict => {
    const res = doc.resolve(doc.Pages[0].Resources) as PdfDict;
    const egs = doc.resolve(res.get('ExtGState')) as PdfDict;
    return doc.resolve(egs.get(key)) as PdfDict;
  };

  it('removes ExtGState /TR and /HTO', () => {
    const r = conv({ trExtGState: true, htoExtGState: true });
    expect(r.applied.filter((x) => x === 'ExtGStateKeys').length).toBe(2);
    expect(r.errors).not.toContain('ExtGStateKeys');
  });

  it('forces a non-/Default /TR2 to /Default rather than deleting it', () => {
    const r = conv({ tr2ExtGState: true });
    expect(r.applied).toContain('ExtGStateKeys');
    expect(r.errors).not.toContain('ExtGStateKeys');
    expect(extGState(r.doc, 'GS2').get('TR2')).toEqual({ kind: 'name', name: 'Default' });
  });

  it('removes /HalftoneName', () => {
    const r = conv({ halftoneName: true });
    expect(r.applied).toContain('Halftone');
    expect(r.errors).not.toContain('Halftone');
  });

  it('reports a prohibited halftone type rather than forcing it to 1', () => {
    // Forcing the type would change how the page prints; reporting beats that.
    const r = conv({ badHalftone: true });
    expect(r.applied).not.toContain('Halftone');
    expect(r.errors).toContain('Halftone');
  });

  it('removes image /Alternates, image /OPI and Form XObject /OPI', () => {
    const r = conv({ imageAlternates: true, imageOpi: true, formOpi: true });
    expect(r.errors).not.toContain('ImageKeys');
    expect(r.errors).not.toContain('FormXObjectOpi');
  });

  it('reports a bad /BitsPerComponent rather than re-encoding the image', () => {
    const r = conv({ badBitsPerComponent: true });
    expect(r.errors).toContain('ImageKeys');
  });

  it('leaves ExtGState /HTO alone at parts 1-3', () => {
    // This case asserted the same of /TR until pjy7, which is the gating that
    // issue reverses: ISO 19005-1 6.2.8-1 and -2/-3 6.2.5-1 carry the transfer
    // function test too. /HTO is what remains part-4-only, being a PDF 2.0 key.
    const doc = open(buildPdfaPdf({ htoExtGState: true }, 2));
    doc.ConvertToPdfA('2b');
    expect(extGState(doc, 'GSh').get('HTO')).toBeDefined();
  });
});

describe('ConvertToPdfA — part 4 output intents', () => {
  const conv = (opts: any) => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA('4');
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA('4').Errors.map((e) => e.rule) };
  };

  it('removes /DestOutputProfileRef', () => {
    const r = conv({ destOutputProfileRef: true });
    expect(r.applied).toContain('OutputIntentKeys');
    expect(r.errors).not.toContain('OutputIntentKeys');
  });

  it('drops a surplus PDF/A output intent, keeping the first', () => {
    const r = conv({ twoPdfaOutputIntents: true });
    expect(r.applied).toContain('OutputIntentKeys');
    expect(r.errors).not.toContain('OutputIntentKeys');
    const ois = r.doc.resolve(r.doc.catalog().get('OutputIntents')) as unknown[];
    expect(ois.length).toBe(1);
  });

  it('leaves the whole pass alone at part 1', () => {
    // This case asserted the same of part 2 until pjy7: ISO 19005-2/-3 6.2.3-3
    // carries the /DestOutputProfileRef test, so the pass now repairs there.
    // Part 1's profile has no such rule, which is where it stays silent.
    const doc = open(buildPdfaPdf({ headerVersion: '1.4', destOutputProfileRef: true }, 1));
    doc.ConvertToPdfA('1b');
    const ois = doc.resolve(doc.catalog().get('OutputIntents')) as PdfObject[];
    const oi = doc.resolve(ois[0]) as PdfDict;
    expect(oi.get('DestOutputProfileRef')).toBeDefined();
  });
});

describe('ConvertToPdfA — part 4 annotations', () => {
  const conv = (opts: any, lvl: any = '4') => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };
  const firstAnnot = (doc: Document): PdfDict => {
    const arr = doc.resolve(doc.Pages[0].Dict.get('Annots')) as PdfObject[];
    return doc.resolve(arr[0]) as PdfDict;
  };

  it('removes appearance keys other than /N', () => {
    const r = conv({ apWithDown: true });
    expect(r.applied).toContain('AppearanceKeys');
    expect(r.errors).not.toContain('AppearanceKeys');
    const ap = r.doc.resolve(firstAnnot(r.doc).get('AP')) as PdfDict;
    expect([...ap.keys()]).toEqual(['N']);
  });

  it('removes /A from a Widget annotation', () => {
    const r = conv({ widgetWithAction: true });
    expect(r.applied).toContain('WidgetAction');
    expect(r.errors).not.toContain('WidgetAction');
  });

  it('clears the ToggleNoView flag at part 4', () => {
    const r = conv({ toggleNoViewAnnot: true });
    expect(r.applied).toContain('AnnotationFlags');
    expect(r.errors).not.toContain('AnnotationFlags');
    expect(Number(firstAnnot(r.doc).get('F')) & 256).toBe(0);
  });

  it('leaves ToggleNoView alone at parts 1-3, which have no such rule', () => {
    const doc = open(buildPdfaPdf({ toggleNoViewAnnot: true }, 2));
    doc.ConvertToPdfA('2b');
    const arr = doc.resolve(doc.Pages[0].Dict.get('Annots')) as PdfObject[];
    const annot = doc.resolve(arr[0]) as PdfDict;
    expect(Number(annot.get('F')) & 256).toBe(256);
  });
});

describe('ConvertToPdfA — part 4 optional content', () => {
  it('names an optional-content configuration that has none', () => {
    const doc = open(buildPdfaPdf({ ocConfigNoName: true }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('OcConfig');
    expect(doc.ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('OcConfig');
  });

  it('keeps optional content at part 4 - only part 1 removes it', () => {
    const doc = open(buildPdfaPdf({ optionalContent: true }, 4));
    doc.ConvertToPdfA('4');
    expect(doc.catalog().get('OCProperties')).toBeDefined();
    expect(doc.ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('OcConfig');
  });

  it('leaves an already-named configuration untouched', () => {
    const doc = open(buildPdfaPdf({ optionalContent: true }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).not.toContain('OcConfig');
  });
});

describe('ConvertToPdfA — part 4 actions and annotation subtypes', () => {
  const conv = (opts: any, lvl: any = '4') => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };

  it('KEEPS a JavaScript action at part 4, which permits it', () => {
    const r = conv({ jsAction: true });
    expect(r.applied).not.toContain('Actions');
    expect(r.errors).not.toContain('Actions');
    expect(r.doc.catalog().get('OpenAction')).toBeDefined();
  });

  it('still removes a JavaScript action at parts 1-3', () => {
    const doc = open(buildPdfaPdf({ jsAction: true }, 2));
    doc.ConvertToPdfA('2b');
    expect(doc.catalog().get('OpenAction')).toBeUndefined();
  });

  it('removes a /Launch action at part 4', () => {
    const r = conv({ launchAction: true });
    expect(r.applied).toContain('Actions');
    expect(r.errors).not.toContain('Actions');
  });

  it('removes SetOCGState at 4 and keeps it at 4e', () => {
    expect(conv({ setOcgStateAction: true }, '4').doc.catalog().get('OpenAction')).toBeUndefined();
    const e = conv({ setOcgStateAction: true }, '4e');
    expect(e.doc.catalog().get('OpenAction')).toBeDefined();
    expect(e.errors).not.toContain('Actions');
  });

  it('removes an /AA key outside the part-4 permitted set', () => {
    const r = conv({ additionalAction: true });   // catalog /AA << /WC ... >>
    expect(r.applied).toContain('AdditionalActions');
    expect(r.errors).not.toContain('AdditionalActions');
    expect(r.doc.catalog().get('AA')).toBeUndefined();
  });

  it('removes a FileAttachment annotation at part 4, which prohibits it', () => {
    const r = conv({ fileAttachAnnot: true });
    expect(r.applied).toContain('AnnotationSubtype');
    expect(r.errors).not.toContain('AnnotationSubtype');
  });

  it('removes a 3D annotation at 4 and keeps it at 4e', () => {
    expect(conv({ threeDAnnot: true }, '4').applied).toContain('AnnotationSubtype');
    const e = conv({ threeDAnnot: true }, '4e');
    expect(e.applied).not.toContain('AnnotationSubtype');
    expect(e.errors).not.toContain('AnnotationSubtype');
  });
});

describe('ConvertToPdfA — part 4 embedded files', () => {
  it('adds /UF, /AFRelationship and a /Subtype MIME type rather than removing the file', () => {
    const doc = open(buildPdfaPdf({ embeddedFile: 'bare' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('EmbeddedFileSpec');
    expect(doc.ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('EmbeddedFileSpec');
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    expect(names.get('EmbeddedFiles')).toBeDefined();
  });

  it('writes the MIME type as ONE name, letting the serializer escape the slash', () => {
    // A MIME type is a PDF name and `/` is a delimiter inside one, so the value
    // is the name whose TEXT is application/octet-stream. Pre-escaping it in
    // name() double-escapes; a bare /application/octet-stream is not one name.
    const doc = open(buildPdfaPdf({ embeddedFile: 'noMime' }, 4));
    doc.ConvertToPdfA('4');
    const saved = new TextDecoder('latin1').decode(doc.Save());
    expect(saved).toContain('/application#2foctet-stream');
    expect(saved).not.toContain('#232F');
  });

  it('leaves an already-conformant file spec alone', () => {
    const doc = open(buildPdfaPdf({ embeddedFile: 'full' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).not.toContain('EmbeddedFileSpec');
  });

  it('still removes attachments at part 1', () => {
    const doc = open(buildPdfaPdf({ embeddedFile: 'full' }, 1));
    const report = doc.ConvertToPdfA('1b');
    expect(report.applied.map((a) => a.rule)).toContain('EmbeddedFiles');
  });

  it('4f with no attachment reports EmbeddedFilesRequired and remediates the rest', () => {
    // Clause 6.9-5 demands an embedded file and conversion cannot synthesize
    // one, so all three levels are still accepted and this is REPORTED.
    const doc = open(buildPdfaPdf({ headerVersion: '1.7', needsRendering: true }, 4));
    const report = doc.ConvertToPdfA('4f');
    expect(report.unresolved.map((i) => i.rule)).toEqual(['EmbeddedFilesRequired']);
    expect(report.passed).toBe(false);
  });

  it('4f with an attachment converts to passing', () => {
    const doc = open(buildPdfaPdf({ embeddedFile: 'bare' }, 4));
    const report = doc.ConvertToPdfA('4f');
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe('ConvertToPdfA — part 4 end to end', () => {
  const messyOpts = {
    headerVersion: '1.7', infoTitle: 'Messy', omitId: true, omitMetadata: true,
    needsRendering: true, requirements: true, alternatePresentations: true, presSteps: true,
    perms: 'bad' as const, trExtGState: true, htoExtGState: true, tr2ExtGState: true,
    halftoneName: true, imageAlternates: true, imageOpi: true, formOpi: true,
    destOutputProfileRef: true, apWithDown: true, widgetWithAction: true,
    toggleNoViewAnnot: true, ocConfigNoName: true, launchAction: true,
    additionalAction: true, fileAttachAnnot: true, needAppearances: true,
    nonStandardBlend: true, interpolateImage: true,
  };

  for (const level of ['4', '4e'] as const) {
    it(`converts a messy document to a passing ${level}`, () => {
      const doc = open(buildPdfaPdf({ ...messyOpts }, 4));
      const report = doc.ConvertToPdfA(level);
      expect(report.unresolved).toEqual([]);
      expect(report.passed).toBe(true);
      expect(open(doc.Save()).ValidatePdfA(level).Passed).toBe(true);
    });
  }

  it('converts a messy document carrying an attachment to a passing 4f', () => {
    const doc = open(buildPdfaPdf({ ...messyOpts, embeddedFile: 'bare' }, 4));
    const report = doc.ConvertToPdfA('4f');
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
    expect(open(doc.Save()).ValidatePdfA('4f').Passed).toBe(true);
  });

  it('emits no TransparencyBlendingSpace remediation, because the rule is unreachable', () => {
    // outputIntentPass adds a PDF/A output intent whenever there is none, and
    // 6.2.9-2 fires ONLY when there is none - so the rule is closed by
    // construction rather than by a pass somebody forgot to write.
    const doc = open(buildPdfaPdf({ groupNoCs: true, omitOutputIntent: true }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).not.toContain('TransparencyBlendingSpace');
    expect(report.unresolved.map((i) => i.rule)).not.toContain('TransparencyBlendingSpace');
  });

  it('reports the rules conversion deliberately does not fix', () => {
    const bpc = open(buildPdfaPdf({ badBitsPerComponent: true }, 4));
    expect(bpc.ConvertToPdfA('4').unresolved.map((i) => i.rule)).toContain('ImageKeys');

    const ht = open(buildPdfaPdf({ badHalftone: true }, 4));
    expect(ht.ConvertToPdfA('4').unresolved.map((i) => i.rule)).toContain('Halftone');

    // Deleting the offending CMap would be LEGAL at part 4 (no /ToUnicode
    // presence requirement) and would destroy text extraction to fix a handful
    // of bad code points. Reporting beats silently taking that trade.
    const tu = open(buildPdfaPdf({ type0: true, badToUnicode: true }, 4));
    expect(tu.ConvertToPdfA('4').unresolved.map((i) => i.rule)).toContain('ToUnicodeContent');

    const font = open(buildPdfaPdf({ fontEmbedded: false }, 4));
    expect(font.ConvertToPdfA('4').unresolved.map((i) => i.rule)).toContain('FontEmbedded');
  });
});

describe('ConvertToPdfA — the backported graphics and output-intent passes (pjy7)', () => {
  const conv = (opts: any, part: 1 | 2 | 3 | 4, lvl: any) => {
    const doc = open(buildPdfaPdf(part === 1 ? { headerVersion: '1.4', ...opts } : opts, part));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };

  it('removes ExtGState /TR at parts 1-3 as well as 4', () => {
    for (const [part, lvl] of [[1, '1b'], [2, '2b'], [3, '3b']] as const) {
      const r = conv({ trExtGState: true }, part, lvl);
      expect(r.applied).toContain('ExtGStateKeys');
      expect(r.errors).not.toContain('ExtGStateKeys');
    }
  });

  it('removes image /Alternates and form /OPI at parts 1-3', () => {
    const r = conv({ imageAlternates: true, formOpi: true }, 2, '2b');
    expect(r.errors).not.toContain('ImageKeys');
    expect(r.errors).not.toContain('FormXObjectOpi');
  });

  it('removes /HalftoneName at part 2 and leaves part 1 alone', () => {
    expect(conv({ halftoneName: true }, 2, '2b').applied).toContain('Halftone');
    // Part 1 has no halftone rule, so there is nothing to repair and nothing
    // to report - the pass must not "fix" what the standard permits.
    expect(conv({ halftoneName: true }, 1, '1b').applied).not.toContain('Halftone');
  });

  it('removes /DestOutputProfileRef from a PDF/A intent at parts 2-3', () => {
    const r = conv({ destOutputProfileRef: true }, 2, '2b');
    expect(r.applied).toContain('OutputIntentKeys');
    expect(r.errors).not.toContain('OutputIntentKeys');
  });

  it('LEAVES a GTS_PDFX intent alone at parts 2-3, where it is exempt', () => {
    const r = conv({ pdfxIntentProfileRef: true }, 2, '2b');
    expect(r.applied).not.toContain('OutputIntentKeys');
    expect(r.errors).not.toContain('OutputIntentKeys');
    // Asserted on the saved bytes rather than by walking the array: the key
    // must SURVIVE, and the surrounding /S tells which intent kept it.
    const saved = new TextDecoder('latin1').decode(r.doc.Save());
    expect(saved).toContain('/DestOutputProfileRef');
  });

  it('reports a bad /BitsPerComponent at parts 1-3 rather than re-encoding', () => {
    expect(conv({ badBitsPerComponent: true }, 2, '2b').errors).toContain('ImageKeys');
  });
});

describe('ConvertToPdfA — widget actions and the formActions category (pjy7)', () => {
  const conv = (opts: any, part: 1 | 2 | 3 | 4, lvl: any, o?: any) => {
    const doc = open(buildPdfaPdf(part === 1 ? { headerVersion: '1.4', ...opts } : opts, part));
    const r = doc.ConvertToPdfA(lvl, o);
    return { doc, applied: r.applied.map((a) => a.rule),
      unresolved: r.unresolved.map((i) => i.rule),
      errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };
  const firstAnnot = (doc: Document): PdfDict => {
    const arr = doc.resolve(doc.Pages[0].Dict.get('Annots')) as PdfObject[];
    return doc.resolve(arr[0]) as PdfDict;
  };

  it('strips a Widget /A at parts 1-3 as well as 4', () => {
    for (const [part, lvl] of [[1, '1b'], [2, '2b'], [3, '3b']] as const) {
      const r = conv({ widgetWithAction: true }, part, lvl);
      expect(r.applied).toContain('WidgetAction');
      expect(r.errors).not.toContain('WidgetAction');
    }
  });

  it('strips a Widget /AA at parts 1-3 and leaves it at part 4', () => {
    const two = conv({ widgetWithAA: true }, 2, '2b');
    expect(two.applied).toContain('WidgetAction');
    expect(two.errors).not.toContain('WidgetAction');
    // Part 4 exempts a Widget's /AA, so the pass must not remove it there.
    const four = conv({ widgetWithAA: true }, 4, '4');
    expect(four.applied).not.toContain('WidgetAction');
    expect(firstAnnot(four.doc).get('AA')).toBeDefined();
  });

  it('preserve: [formActions] keeps the actions AND reports them unresolved', () => {
    // Both halves, since either alone passes with the category ignored.
    const r = conv({ widgetWithAction: true }, 2, '2b', { preserve: ['formActions'] });
    expect(r.applied).not.toContain('WidgetAction');
    expect(firstAnnot(r.doc).get('A')).toBeDefined();
    expect(r.unresolved).toContain('WidgetAction');
  });

  it('removes non-/N appearance keys at parts 1-3', () => {
    const r = conv({ apWithDown: true }, 2, '2b');
    expect(r.applied).toContain('AppearanceKeys');
    expect(r.errors).not.toContain('AppearanceKeys');
  });

  it('does not let formActions preserve the appearance prune', () => {
    // The category names ACTIONS; an /AP key is a different construct, and a
    // category that quietly widened would keep a defect the caller never asked
    // to keep.
    const r = conv({ apWithDown: true }, 2, '2b', { preserve: ['formActions'] });
    expect(r.applied).toContain('AppearanceKeys');
  });
});

describe('ConvertToPdfA — a messy document still converts clean at parts 1-3 (pjy7)', () => {
  // The premise of widening the converter alongside the validator: a document
  // carrying every newly-detected defect must still reach passed === true.
  const messy = {
    trExtGState: true, tr2ExtGState: true, halftoneName: true,
    imageAlternates: true, imageOpi: true, formOpi: true,
    destOutputProfileRef: true, apWithDown: true, widgetWithAction: true,
    widgetWithAA: true, needsRendering: true, needAppearances: true,
  };

  for (const [part, lvl] of [[2, '2b'], [3, '3b']] as const) {
    it(`converts to a passing ${lvl}`, () => {
      const doc = open(buildPdfaPdf(messy, part));
      const report = doc.ConvertToPdfA(lvl);
      expect(report.unresolved).toEqual([]);
      expect(report.passed).toBe(true);
      expect(open(doc.Save()).ValidatePdfA(lvl).Passed).toBe(true);
    });
  }

  it('converts to a passing 1b', () => {
    // Part 1 drops the halftone and /NeedsRendering members: neither is a
    // part-1 rule, so leaving them in would assert the converter repairs
    // something the standard permits.
    const { halftoneName, needsRendering, ...rest } = messy;
    const doc = open(buildPdfaPdf({ headerVersion: '1.4', ...rest }, 1));
    const report = doc.ConvertToPdfA('1b');
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('reports the part-1 16-bit image rather than re-encoding it', () => {
    // The one genuinely NEW failure this backport introduces: legal at 2/3/4,
    // illegal at 1, and not mechanically fixable.
    const doc = open(buildPdfaPdf({ headerVersion: '1.4', bpc16Image: true }, 1));
    expect(doc.ConvertToPdfA('1b').unresolved.map((i) => i.rule)).toContain('ImageKeys');
    const ok = open(buildPdfaPdf({ bpc16Image: true }, 2));
    expect(ok.ConvertToPdfA('2b').passed).toBe(true);
  });
});
