import type { Document } from './document.js';
import { PdfObject, PdfDict, isDict, isName, isArray, isStream, isString } from './types.js';
import { ValidationReport, type ValidationIssue } from './validation.js';
import {
  type Ctx, memo, nameOf, xmpText, allObjects, filterNames, pageScans,
  enumerateFonts, descendantFont, hasFontProgram, extGStates, blendModeName, eachAnnotation,
} from './validatectx.js';

/** PDF/X conformance target. '4p' is X-4 with the output-intent profile
 *  referenced externally rather than embedded (ISO 15930-7). */
export type PdfXLevel = '1a' | '3' | '4' | '4p';

/** PDF/X run context: the shared scan context plus the conformance target. */
export interface XCtx extends Ctx { level: PdfXLevel }

type Rule = (ctx: XCtx) => ValidationIssue[];

/** The GTS_PDFXVersion string a level must declare. '4p' identifies as X-4;
 *  the two differ only in how the output-intent profile is supplied. */
export function xVersionString(level: PdfXLevel): string {
  if (level === '1a') return 'PDF/X-1a:2003';
  if (level === '3') return 'PDF/X-3:2003';
  return 'PDF/X-4';
}

/** Every GTS_PDFXVersion string that identifies a level. X-1a and X-3 each have
 *  two conformant vintages — ISO 15930-1:2001 / 15930-3:2002 and their 2003
 *  revisions 15930-4 / 15930-6 — and producers still write the earlier ones
 *  (Ghostscript emits `PDF/X-3:2002`). Validation accepts either; conversion
 *  writes `xVersionString`, the newer of the two. */
export function xVersionStrings(level: PdfXLevel): string[] {
  if (level === '1a') return ['PDF/X-1a:2001', 'PDF/X-1a:2003'];
  if (level === '3') return ['PDF/X-3:2002', 'PDF/X-3:2003'];
  return ['PDF/X-4'];
}

/** True for the levels that predate PDF/X-4: they use the /Info key as well as
 *  XMP, cap at PDF 1.4, and prohibit transparency, layers and embedded files. */
export function isLegacy(level: PdfXLevel): boolean {
  return level === '1a' || level === '3';
}

/** Entry point. The facade supplies the catalog (mirrors validatePdfA). */
export function validatePdfX(doc: Document, catalog: PdfDict, level: PdfXLevel): ValidationReport {
  const ctx: XCtx = { doc, catalog, level, R: (o) => doc.resolve(o), cache: new Map() };
  const issues: ValidationIssue[] = [];
  for (const rule of RULES) issues.push(...rule(ctx));
  return new ValidationReport(issues);
}

/** The document's /Info dictionary, or undefined. */
export function infoDict(ctx: XCtx): PdfDict | undefined {
  const info = ctx.R(ctx.doc.trailer.get('Info'));
  return isDict(info) ? info : undefined;
}

/** A /Info string entry's text, or undefined. */
export function infoString(ctx: XCtx, key: string): string | undefined {
  const info = infoDict(ctx);
  const v = info ? ctx.R(info.get(key)) : undefined;
  return isString(v) ? new TextDecoder('latin1').decode(v.bytes) : undefined;
}

// ---- identification --------------------------------------------------------

/** The pdfxid:GTS_PDFXVersion value carried by an XMP packet, if any. */
function xmpVersion(xmp: string): string | undefined {
  // `*` rather than `+` (ugxr): an empty declaration is a present property with
  // an invalid value, so it is reported as the wrong version rather than read
  // as no identification at all.
  const m = /pdfxid:GTS_PDFXVersion\s*=\s*["']([^"']*)["']/.exec(xmp)
    ?? /<pdfxid:GTS_PDFXVersion>\s*([^<]*?)\s*<\/pdfxid:GTS_PDFXVersion>/.exec(xmp);
  return m?.[1].trim();
}

/** Where a level's identification lives differs, and conflating the two
 *  over-enforces: X-1a and X-3 identify through the /Info key (ISO 15930-1/-4
 *  and -3/-6), while the XMP pdfxid packet is X-4's mechanism (ISO 15930-7).
 *  Requiring XMP at the legacy levels rejects conformant files — Ghostscript's
 *  own -dPDFX output for X-3 has no XMP at all. */
const identificationRule: Rule = (ctx) => {
  const accepted = xVersionStrings(ctx.level);
  const expected = accepted.map((s) => `'${s}'`).join(' or ');
  const issues: ValidationIssue[] = [];
  const xmp = xmpText(ctx);
  const inXmp = xmp === undefined ? undefined : xmpVersion(xmp);

  if (isLegacy(ctx.level)) {
    const got = infoString(ctx, 'GTS_PDFXVersion')?.trim();
    if (got === undefined) {
      issues.push({ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-4 §6.2',
        message: '/Info carries no /GTS_PDFXVersion key, required for PDF/X-1a and X-3.' });
    } else if (!accepted.includes(got)) {
      issues.push({ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-4 §6.2',
        message: `/Info declares GTS_PDFXVersion '${got}'; expected ${expected}.` });
    }
    // XMP is optional here, but one that contradicts /Info is inconsistent.
    if (inXmp !== undefined && !accepted.includes(inXmp)) {
      issues.push({ rule: 'PdfxIdentification', severity: 'warning', clause: 'ISO 15930-4 §6.2',
        message: `XMP declares pdfxid:GTS_PDFXVersion '${inXmp}', which disagrees with ${expected}.` });
    }
    return issues;
  }

  if (xmp === undefined) {
    return [{ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-7 §6.2',
      message: 'No /Root /Metadata XMP packet; PDF/X-4 requires pdfxid identification.' }];
  }
  if (inXmp === undefined) {
    issues.push({ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-7 §6.2',
      message: 'XMP carries no pdfxid:GTS_PDFXVersion.' });
  } else if (!accepted.includes(inXmp)) {
    issues.push({ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-7 §6.2',
      message: `XMP declares pdfxid:GTS_PDFXVersion '${inXmp}'; expected ${expected}.` });
  }
  return issues;
};

// ---- output intent ---------------------------------------------------------

/** Standard characterization names that may stand in for an embedded profile.
 *  Transcribed from the ICC characterization data registry at
 *  https://registry.color.org/cmyk-registry/ , retrieved 2026-07-21. The registry
 *  gains entries over time, so this will drift again — re-transcribe the whole
 *  table rather than appending ad hoc. Unknown names are reported as
 *  unregistered, so a stale set rejects conformant files; the set is consulted
 *  only on the no-profile branch, which is what ConvertToPdfX emits by default.
 *  Note 'CGATS TR 001' carries the space: Ghostscript's PDFX_def.ps sample
 *  spells it 'CGATS TR001', which the registry does not list. */
const REGISTERED_CONDITIONS = new Set([
  'CGATS TR 001', 'CGATS TR 002', 'CGATS TR 003', 'CGATS TR 005', 'CGATS TR 006',
  'CGATS21-2-CRPC1', 'CGATS21-2-CRPC2', 'CGATS21-2-CRPC3', 'CGATS21-2-CRPC4',
  'CGATS21-2-CRPC5', 'CGATS21-2-CRPC6', 'CGATS21-2-CRPC7',
  'FOGRA27', 'FOGRA28', 'FOGRA29', 'FOGRA30', 'FOGRA31', 'FOGRA32', 'FOGRA33',
  'FOGRA34', 'FOGRA35', 'FOGRA36', 'FOGRA37', 'FOGRA38', 'FOGRA39', 'FOGRA40',
  'FOGRA41', 'FOGRA42', 'FOGRA43', 'FOGRA44', 'FOGRA45', 'FOGRA46', 'FOGRA47',
  'FOGRA48', 'FOGRA49', 'FOGRA50', 'FOGRA51', 'FOGRA52', 'FOGRA53', 'FOGRA54',
  'APTEC_CTV_3', 'APTEC_CTV_4', 'APTEC_CTV_5', 'APTEC_CTV_6', 'APTEC_CTV_7', 'APTEC_CTV_8',
  'APTEC Coated CardBoard', 'APTEC CCNB',
  'IFRA26', 'JC200103', 'JC200104', 'JCN2002', 'JCW2003', 'JCS2011',
  'EUROSB104', 'EUROSB204',
  // Not in the registry, but seen in the wild and accepted historically. Kept
  // deliberately: over-accepting a name misses an error, while dropping one
  // rejects a file we used to pass.
  'CGATS TR 001 SWOP', 'IFRA30', 'PSO_Coated_300_NPscreen_ISO12647_eci',
]);

/** Every PDF/X output intent dict in the catalog. */
export function pdfxIntents(ctx: XCtx): PdfDict[] {
  return memo(ctx, 'xoi', () => {
    const ois = ctx.R(ctx.catalog.get('OutputIntents'));
    if (!isArray(ois)) return [];
    return ois.map(ctx.R).filter(isDict).filter((oi) => nameOf(ctx, oi, 'S') === 'GTS_PDFX');
  });
}

/** The single PDF/X output intent, or undefined when absent or ambiguous. */
export function pdfxOutputIntent(ctx: XCtx): PdfDict | undefined {
  const all = pdfxIntents(ctx);
  return all.length === 1 ? all[0] : undefined;
}

const outputIntentRule: Rule = (ctx) => {
  const all = pdfxIntents(ctx);
  if (all.length === 0) {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-7 §6.3',
      message: 'No /OutputIntents entry with /S /GTS_PDFX; PDF/X requires exactly one.' }];
  }
  if (all.length > 1) {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-7 §6.3',
      message: `Found ${all.length} PDF/X output intents; exactly one is permitted.` }];
  }
  const oi = all[0];
  const profile = ctx.R(oi.get('DestOutputProfile'));
  const external = ctx.R(oi.get('DestOutputProfileRef'));
  const idValue = ctx.R(oi.get('OutputConditionIdentifier'));
  const id = isString(idValue) ? new TextDecoder('latin1').decode(idValue.bytes).trim() : undefined;

  if (isStream(profile)) return [];
  if (ctx.level === '4p') {
    if (isDict(external) && external.get('F') !== undefined) return [];
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-7 §6.3',
      message: 'PDF/X-4p requires /DestOutputProfileRef with a file specification when no profile is embedded.' }];
  }
  if (isDict(external)) {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-7 §6.3',
      message: '/DestOutputProfileRef is permitted only in PDF/X-4p.' }];
  }
  if (id !== undefined && REGISTERED_CONDITIONS.has(id)) return [];
  return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-4 §6.3',
    message: id === undefined
      ? 'Output intent has neither /DestOutputProfile nor /OutputConditionIdentifier.'
      : `Output intent has no /DestOutputProfile and '${id}' is not a registered characterization name.` }];
};

// ---- structure -------------------------------------------------------------

const trappedRule: Rule = (ctx) => {
  const info = infoDict(ctx);
  const v = info ? ctx.R(info.get('Trapped')) : undefined;
  const val = isName(v) ? v.name : undefined;
  if (val === 'True' || val === 'False') return [];
  return [{ rule: 'Trapped', severity: 'error', clause: 'ISO 15930-4 §6.2',
    message: val === undefined
      ? '/Info has no /Trapped key; PDF/X requires /True or /False.'
      : `/Info /Trapped is /${val}; PDF/X requires /True or /False.` }];
};

/** A rectangle normalized to [llx, lly, urx, ury], or undefined. */
function rect(ctx: XCtx, v: PdfObject | undefined): [number, number, number, number] | undefined {
  const a = ctx.R(v);
  if (!isArray(a) || a.length !== 4) return undefined;
  const n = a.map((e) => ctx.R(e)).filter((e): e is number => typeof e === 'number');
  if (n.length !== 4) return undefined;
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

/** Normalize a number[] box (from the inheriting Page accessors). */
function norm(b: number[]): [number, number, number, number] | undefined {
  if (b.length !== 4) return undefined;
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

/** True when `inner` lies within `outer` (a half-point tolerance absorbs rounding). */
function within(inner: [number, number, number, number], outer: [number, number, number, number]): boolean {
  const t = 0.5;
  return inner[0] >= outer[0] - t && inner[1] >= outer[1] - t
    && inner[2] <= outer[2] + t && inner[3] <= outer[3] + t;
}

const pageGeometryRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  for (const page of ctx.doc.Pages) {
    // Presence must come from the page's own dict: the Page accessors fall back
    // to CropBox, so they can never report a box as absent.
    const trim = page.Dict.get('TrimBox');
    const art = page.Dict.get('ArtBox');
    if (trim === undefined && art === undefined) {
      issues.push({ rule: 'PageGeometry', severity: 'error', clause: 'ISO 15930-7 §6.4', page,
        message: 'Page has neither /TrimBox nor /ArtBox; PDF/X requires one.' });
      continue;
    }
    if (trim !== undefined && art !== undefined) {
      issues.push({ rule: 'PageGeometry', severity: 'error', clause: 'ISO 15930-7 §6.4', page,
        message: 'Page has both /TrimBox and /ArtBox; PDF/X permits only one.' });
    }
    const media = norm(page.MediaBox);
    const bleed = rect(ctx, page.Dict.get('BleedBox'));
    if (media && bleed && !within(bleed, media)) {
      issues.push({ rule: 'PageGeometry', severity: 'error', clause: 'ISO 15930-7 §6.4', page,
        message: 'Page /BleedBox extends outside the /MediaBox.' });
    }
    const t = rect(ctx, trim) ?? rect(ctx, art);
    const outer = bleed ?? media;
    if (t && outer && !within(t, outer)) {
      issues.push({ rule: 'PageGeometry', severity: 'error', clause: 'ISO 15930-7 §6.4', page,
        message: 'Page /TrimBox (or /ArtBox) extends outside the /BleedBox or /MediaBox.' });
    }
  }
  return issues;
};

const versionRule: Rule = (ctx) => {
  const ceiling = isLegacy(ctx.level) ? 1.4 : 1.6;
  const over = (v: string | undefined): boolean => v !== undefined && Number(v) > ceiling + 1e-9;
  if (over(ctx.doc.headerVersion()) || over(nameOf(ctx, ctx.catalog, 'Version'))) {
    return [{ rule: 'Version', severity: 'error', clause: 'ISO 15930-4 §6.1',
      message: `PDF version exceeds the ${xVersionString(ctx.level)} ceiling (${ceiling}).` }];
  }
  return [];
};

const filtersRule: Rule = (ctx) => {
  const banned = new Set(isLegacy(ctx.level) ? ['LZWDecode', 'JPXDecode'] : ['LZWDecode']);
  return allObjects(ctx).flatMap(([object, obj]) => {
    if (!isStream(obj)) return [];
    const hit = filterNames(obj.dict, ctx.R).find((f) => banned.has(f));
    return hit === undefined ? [] : [{
      rule: 'Filters', severity: 'error' as const, clause: 'ISO 15930-4 §6.1', object,
      message: `Stream uses the prohibited /${hit} filter.`,
    }];
  });
};

const encryptionRule: Rule = (ctx) =>
  ctx.doc.trailer.get('Encrypt') === undefined ? [] : [{
    rule: 'Encryption', severity: 'error', clause: 'ISO 15930-4 §6.1',
    message: 'Document is encrypted; PDF/X forbids encryption.',
  }];

const fileIdRule: Rule = (ctx) => {
  const id = ctx.doc.trailer.get('ID');
  return isArray(id) && id.length === 2 ? [] : [{
    rule: 'FileID', severity: 'error', clause: 'ISO 15930-4 §6.1',
    message: 'Trailer has no /ID array; PDF/X requires a file identifier.',
  }];
};

const externalStreamRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && obj.dict.get('F') !== undefined
      ? [{ rule: 'ExternalStream', severity: 'error' as const, clause: 'ISO 15930-4 §6.1', object,
          message: 'Stream references external file data (/F); PDF/X requires embedded data.' }]
      : []);

const xobjectRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) => {
    if (!isStream(obj)) return [];
    const sub = nameOf(ctx, obj.dict, 'Subtype');
    if (sub === 'PS' || obj.dict.get('PS') !== undefined) {
      return [{ rule: 'PostScriptXObject', severity: 'error' as const, clause: 'ISO 15930-4 §6.2', object,
        message: 'PostScript XObjects are prohibited in PDF/X.' }];
    }
    if (sub === 'Form' && obj.dict.get('Ref') !== undefined) {
      return [{ rule: 'ReferenceXObject', severity: 'error' as const, clause: 'ISO 15930-4 §6.2', object,
        message: 'Reference XObjects (/Ref) are prohibited in PDF/X.' }];
    }
    return [];
  });

const fontEmbeddedRule: Rule = (ctx) =>
  enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    const sub = nameOf(ctx, dict, 'Subtype');
    if (sub === 'Type0') {
      const desc = descendantFont(ctx, dict);
      const ok = desc && hasFontProgram(ctx, desc.get('FontDescriptor'));
      return ok ? [] : [{
        rule: 'FontEmbedded', severity: 'error' as const, clause: 'ISO 15930-4 §6.2', object,
        message: `Type0 font '${nameOf(ctx, dict, 'BaseFont') ?? '?'}' has no embedded descendant font program.` }];
    }
    if (sub === 'Type3') return []; // Type3 glyphs are content streams; no font program.
    return hasFontProgram(ctx, dict.get('FontDescriptor')) ? [] : [{
      rule: 'FontEmbedded', severity: 'error' as const, clause: 'ISO 15930-4 §6.2', object,
      message: `Font '${nameOf(ctx, dict, 'BaseFont') ?? '?'}' is not embedded; PDF/X requires every font embedded.` }];
  });

// ---- color -----------------------------------------------------------------

/** The component count of the output-intent profile, or undefined when the
 *  profile is not embedded (the registered-name and 4p forms). */
export function intentComponents(ctx: XCtx): number | undefined {
  const oi = pdfxOutputIntent(ctx);
  if (!oi) return undefined;
  const profile = ctx.R(oi.get('DestOutputProfile'));
  if (!isStream(profile)) return undefined;
  const n = ctx.R(profile.dict.get('N'));
  return typeof n === 'number' ? n : undefined;
}

/** Spaces X-1a forbids outright: everything but CMYK, Gray, and spot color. */
const X1A_PROHIBITED = new Set(['DeviceRGB', 'CalRGB', 'Lab', 'ICCBased']);

const prohibitedColorRule: Rule = (ctx) => {
  if (ctx.level !== '1a') return [];
  return pageScans(ctx).flatMap((s) => {
    const hits = [...s.colorSpaces].filter((c) => X1A_PROHIBITED.has(c));
    return hits.length === 0 ? [] : [{
      rule: 'ProhibitedColor', severity: 'error' as const, clause: 'ISO 15930-4 §6.3', page: s.page,
      message: `Page uses ${hits.join(', ')}; PDF/X-1a permits only DeviceGray, DeviceCMYK, Separation and DeviceN.`,
    }];
  });
};

const colorWithoutIntentRule: Rule = (ctx) => {
  const n = intentComponents(ctx);
  if (n === undefined) return []; // no embedded profile ⇒ nothing to disagree with
  const wanted = n === 4 ? 'DeviceCMYK' : n === 3 ? 'DeviceRGB' : undefined;
  if (wanted === undefined) return [];
  const other = wanted === 'DeviceCMYK' ? 'DeviceRGB' : 'DeviceCMYK';
  return pageScans(ctx).flatMap((s) =>
    s.colorSpaces.has(other)
      ? [{ rule: 'ColorWithoutIntent', severity: 'error' as const, clause: 'ISO 15930-6 §6.3', page: s.page,
          message: `Page uses ${other} but the output intent describes a ${wanted} condition (/N ${n}).` }]
      : []);
};

const outputIntentColorRule: Rule = (ctx) => {
  if (ctx.level !== '1a') return [];
  const n = intentComponents(ctx);
  if (n === undefined || n === 4 || n === 1) return [];
  return [{ rule: 'OutputIntentColor', severity: 'error', clause: 'ISO 15930-4 §6.3',
    message: `Output-intent profile has /N ${n}; PDF/X-1a requires a CMYK (4) or Gray (1) condition.` }];
};

// ---- transparency, layers, embedded files ----------------------------------

const transparencyRule: Rule = (ctx) => {
  if (!isLegacy(ctx.level)) return []; // X-4 permits live transparency
  const issues: ValidationIssue[] = [];
  for (const [object, obj] of allObjects(ctx)) {
    const dict = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (!dict) continue;
    const grp = ctx.R(dict.get('Group'));
    if (isDict(grp) && nameOf(ctx, grp, 'S') === 'Transparency') {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 15930-4 §6.4', object,
        message: `Transparency group is prohibited in ${xVersionString(ctx.level)}.` });
    }
  }
  for (const { ref: object, dict } of extGStates(ctx)) {
    // Presence must be checked on the raw dict: doc.resolve(undefined) returns
    // null, so resolving first would make every absent key look present.
    const sm = dict.get('SMask') === undefined ? undefined : ctx.R(dict.get('SMask'));
    if (sm !== undefined && !(isName(sm) && sm.name === 'None')) {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 15930-4 §6.4', object,
        message: 'ExtGState /SMask other than /None implies transparency.' });
    }
    const bm = blendModeName(ctx, dict);
    if (bm && bm !== 'Normal' && bm !== 'Compatible') {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 15930-4 §6.4', object,
        message: `ExtGState blend mode '${bm}' implies transparency.` });
    }
    for (const k of ['CA', 'ca']) {
      const v = ctx.R(dict.get(k));
      if (typeof v === 'number' && v < 1) {
        issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 15930-4 §6.4', object,
          message: `ExtGState /${k} ${v} (< 1) implies transparency.` });
      }
    }
  }
  return issues;
};

const optionalContentRule: Rule = (ctx) => {
  if (!isLegacy(ctx.level)) return [];
  if (ctx.catalog.get('OCProperties') === undefined) return [];
  return [{ rule: 'OptionalContent', severity: 'error', clause: 'ISO 15930-4 §6.1',
    message: `Optional content (/OCProperties) is prohibited in ${xVersionString(ctx.level)}.` }];
};

const embeddedFilesRule: Rule = (ctx) => {
  if (!isLegacy(ctx.level)) return []; // X-4 permits embedded files
  // /FileAttachment annotations are the annotationsRule's business; reporting
  // them here too would surface one defect under two rule ids.
  const names = ctx.R(ctx.catalog.get('Names'));
  if (!isDict(names) || names.get('EmbeddedFiles') === undefined) return [];
  return [{ rule: 'EmbeddedFiles', severity: 'error', clause: 'ISO 15930-4 §6.1',
    message: `Embedded files are prohibited in ${xVersionString(ctx.level)}.` }];
};

/** Halftone dictionary types PDF/X permits. */
const ALLOWED_HALFTONE_TYPES = new Set([1, 5]);

const transferHalftoneRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  for (const { ref: object, dict } of extGStates(ctx)) {
    for (const k of ['TR', 'TR2']) {
      if (dict.get(k) === undefined) continue; // see the /SMask note above
      const v = ctx.R(dict.get(k));
      if (!(isName(v) && v.name === 'Default')) {
        issues.push({ rule: 'TransferHalftone', severity: 'error', clause: 'ISO 15930-4 §6.2', object,
          message: `ExtGState /${k} transfer function is prohibited in PDF/X.` });
      }
    }
    if (dict.get('HTP') !== undefined) {
      issues.push({ rule: 'TransferHalftone', severity: 'error', clause: 'ISO 15930-4 §6.2', object,
        message: 'ExtGState /HTP is prohibited in PDF/X.' });
    }
    const ht = ctx.R(dict.get('HT'));
    const htDict = isStream(ht) ? ht.dict : isDict(ht) ? ht : undefined;
    if (htDict) {
      const t = ctx.R(htDict.get('HalftoneType'));
      if (typeof t === 'number' && !ALLOWED_HALFTONE_TYPES.has(t)) {
        issues.push({ rule: 'TransferHalftone', severity: 'error', clause: 'ISO 15930-4 §6.2', object,
          message: `Halftone type ${t} is prohibited; PDF/X permits types 1 and 5.` });
      }
    }
  }
  return issues;
};

// ---- annotations and actions -----------------------------------------------

const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);

/** `/FileAttachment` is prohibited only where embedded files are — X-4 permits
 *  both, so this must stay consistent with `embeddedFilesRule`. */
function annotProhibited(ctx: XCtx, subtype: string): boolean {
  if (PROHIBITED_ANNOTS.has(subtype)) return true;
  return subtype === 'FileAttachment' && isLegacy(ctx.level);
}

/** True when the two rectangles share any area. */
function overlaps(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

const annotationsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  for (const { ref: object, dict, page } of eachAnnotation(ctx)) {
    const sub = nameOf(ctx, dict, 'Subtype');
    if (sub !== undefined && annotProhibited(ctx, sub)) {
      issues.push({ rule: 'Annotations', severity: 'error', clause: 'ISO 15930-4 §6.5', object, page,
        message: `Annotation subtype /${sub} is prohibited in ${xVersionString(ctx.level)}.` });
      continue;
    }
    if (sub === 'Popup' || sub === 'Link') continue; // no printed mark of their own
    const r = rect(ctx, dict.get('Rect'));
    const zone = rect(ctx, page.Dict.get('BleedBox')) ?? rect(ctx, page.Dict.get('TrimBox'))
      ?? rect(ctx, page.Dict.get('ArtBox'));
    if (r && zone && overlaps(r, zone)) {
      issues.push({ rule: 'Annotations', severity: 'error', clause: 'ISO 15930-4 §6.5', object, page,
        message: 'Annotation /Rect overlaps the trim/bleed area; PDF/X requires annotations outside it.' });
    }
  }
  return issues;
};

const PROHIBITED_ACTIONS = new Set([
  'JavaScript', 'Launch', 'Movie', 'Sound', 'ImportData', 'ResetForm', 'URI',
]);

/** Every /S action type reachable from `actionObj` through /Next chains. */
function collectActionTypes(ctx: XCtx, actionObj: PdfObject | undefined, seen = new Set<PdfDict>()): string[] {
  const a = ctx.R(actionObj);
  if (!isDict(a) || seen.has(a)) return [];
  seen.add(a);
  const out: string[] = [];
  const s = nameOf(ctx, a, 'S');
  if (s !== undefined) out.push(s);
  const next = ctx.R(a.get('Next'));
  if (isArray(next)) for (const n of next) out.push(...collectActionTypes(ctx, n, seen));
  else if (isDict(next)) out.push(...collectActionTypes(ctx, a.get('Next'), seen));
  return out;
}

const actionsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const check = (obj: PdfObject | undefined, where: string): void => {
    for (const t of collectActionTypes(ctx, obj)) {
      if (PROHIBITED_ACTIONS.has(t)) {
        issues.push({ rule: 'Actions', severity: 'error', clause: 'ISO 15930-4 §6.5',
          message: `${where} uses the prohibited /${t} action.` });
      }
    }
  };
  check(ctx.catalog.get('OpenAction'), 'Catalog /OpenAction');
  const aa = ctx.R(ctx.catalog.get('AA'));
  if (isDict(aa)) for (const v of aa.values()) check(v, 'Catalog /AA');
  for (const { dict } of eachAnnotation(ctx)) {
    check(dict.get('A'), 'Annotation /A');
    const annotAa = ctx.R(dict.get('AA'));
    if (isDict(annotAa)) for (const v of annotAa.values()) check(v, 'Annotation /AA');
  }
  return issues;
};

const RULES: Rule[] = [
  identificationRule, outputIntentRule,
  trappedRule, pageGeometryRule, versionRule, filtersRule,
  encryptionRule, fileIdRule, externalStreamRule, xobjectRule, fontEmbeddedRule,
  prohibitedColorRule, colorWithoutIntentRule, outputIntentColorRule,
  transparencyRule, optionalContentRule, embeddedFilesRule, transferHalftoneRule,
  annotationsRule, actionsRule,
];
