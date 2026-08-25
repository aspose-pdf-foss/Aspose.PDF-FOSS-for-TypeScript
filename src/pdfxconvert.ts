import type { Document } from './document.js';
import { PdfObject, PdfDict, PdfRef, isName, isDict, isArray, isRef, isStream, name } from './types.js';
import type { Page } from './page.js';
import type { ConvertAction, ConversionReport } from './conversion.js';
export type { ConvertAction, ConversionReport } from './conversion.js';
import type { ConvertCategory } from './pdfaconvert.js';
import { validatePdfX, xVersionString, isLegacy, type PdfXLevel } from './pdfxvalidate.js';
import { rewriteRgbToCmyk } from './pdfxcolor.js';

export interface PdfXConvertOptions {
  /** Output-intent ICC profile to embed. Omitted → a registered-name intent. */
  iccProfile?: { bytes: Uint8Array; n: 1 | 3 | 4; identifier?: string };
  /** Registered characterization name used when no profile is embedded. */
  outputCondition?: string;
  /** External profile URL/filename, required for '4p' without an embedded profile. */
  outputProfileRef?: string;
  /** /Info /Trapped value written when absent or /Unknown. Default 'False'. */
  trapped?: 'True' | 'False';
  /** Opt-in naive DeviceRGB → DeviceCMYK content rewrite. Default false. */
  convertColor?: boolean;
  /** Destructive-removal categories to skip (then reported unresolved). */
  preserve?: ConvertCategory[];
}

export interface XCctx {
  doc: Document;
  catalog: PdfDict;
  level: PdfXLevel;
  opts: PdfXConvertOptions;
  preserve: Set<ConvertCategory>;
  condition: string;
  R(o: PdfObject | undefined): PdfObject;
}

type Pass = (ctx: XCctx) => ConvertAction[];

/** The default registered characterization name: US commercial offset. */
const DEFAULT_CONDITION = 'CGATS TR 001';

/** Remediate `doc` toward PDF/X `level`, then re-validate. The facade supplies
 *  the catalog (mirrors convertToPdfA). Mutates the live model in place. */
export function convertToPdfX(
  doc: Document, catalog: PdfDict, level: PdfXLevel, opts: PdfXConvertOptions = {},
): ConversionReport {
  const ctx: XCctx = {
    doc, catalog, level, opts,
    preserve: new Set(opts.preserve ?? []),
    condition: opts.outputCondition ?? DEFAULT_CONDITION,
    R: (o) => doc.resolve(o),
  };
  const applied: ConvertAction[] = [];
  for (const pass of PASSES) applied.push(...pass(ctx));
  const unresolved = validatePdfX(doc, catalog, level).Errors;
  return { applied, unresolved, passed: unresolved.length === 0 };
}

const nameOf = (ctx: XCctx, dict: PdfDict, key: string): string | undefined => {
  const v = ctx.R(dict.get(key));
  return isName(v) ? v.name : undefined;
};

const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });

// ---- passes ----------------------------------------------------------------

const identificationPass: Pass = (ctx) => {
  const version = xVersionString(ctx.level);
  ctx.doc.SetXmp({ pdfxVersion: version });
  const actions: ConvertAction[] = [
    { rule: 'PdfxIdentification', action: `Wrote pdfxid:GTS_PDFXVersion '${version}' to XMP.` },
  ];
  if (isLegacy(ctx.level)) {
    ctx.doc.ensureInfo().set('GTS_PDFXVersion', str(version));
    actions.push({ rule: 'PdfxIdentification', action: `Wrote /Info /GTS_PDFXVersion '${version}'.` });
  }
  return actions;
};

/** Declare the level's version ceiling in the catalog. This is unconditional:
 *  the serializer emits the catalog /Version as the `%PDF-x.y` header and
 *  defaults to 1.7 without it, so a converted file would otherwise always
 *  breach the ceiling no matter what the input header said. */
const versionPass: Pass = (ctx) => {
  const ceiling = isLegacy(ctx.level) ? '1.4' : '1.6';
  if (nameOf(ctx, ctx.catalog, 'Version') === ceiling) return [];
  ctx.catalog.set('Version', name(ceiling));
  return [{ rule: 'Version', action: `Set catalog /Version to ${ceiling}.` }];
};

const fileIdPass: Pass = (ctx) => {
  const id = ctx.doc.trailer.get('ID');
  if (isArray(id) && id.length === 2) return [];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = (i * 37 + 11) & 0xff;
  const s = { kind: 'string' as const, bytes };
  ctx.doc.trailer.set('ID', [s, s]);
  return [{ rule: 'FileID', action: 'Generated a trailer /ID.' }];
};

const outputIntentPass: Pass = (ctx) => {
  const existing = ctx.R(ctx.catalog.get('OutputIntents'));
  const intents = isArray(existing) ? existing : [];
  const conformant = intents.some((e) => {
    const oi = ctx.R(e);
    if (!isDict(oi) || nameOf(ctx, oi, 'S') !== 'GTS_PDFX') return false;
    if (isStream(ctx.R(oi.get('DestOutputProfile')))) return true;
    return ctx.level === '4p' && isDict(ctx.R(oi.get('DestOutputProfileRef')));
  });
  if (conformant) return [];

  const oi: PdfDict = new Map<string, PdfObject>([
    ['Type', name('OutputIntent')],
    ['S', name('GTS_PDFX')],
    ['OutputCondition', str('Commercial and specialty printing')],
    ['RegistryName', str('http://www.color.org')],
  ]);
  let object: PdfRef | undefined;
  let how: string;
  if (ctx.opts.iccProfile) {
    const { bytes, n, identifier } = ctx.opts.iccProfile;
    const profile: PdfDict = new Map<string, PdfObject>([['N', n], ['Length', bytes.length]]);
    object = ctx.doc.allocObject({ kind: 'stream', dict: profile, raw: bytes });
    oi.set('OutputConditionIdentifier', str(identifier ?? 'Custom'));
    oi.set('DestOutputProfile', object);
    how = `embedded ${identifier ?? 'custom'} profile`;
  } else if (ctx.level === '4p' && ctx.opts.outputProfileRef !== undefined) {
    const fs: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Filespec')],
      ['FS', name('URL')],
      ['F', str(ctx.opts.outputProfileRef)],
    ]);
    oi.set('OutputConditionIdentifier', str(ctx.condition));
    oi.set('DestOutputProfileRef', fs);
    how = `external profile reference ${ctx.opts.outputProfileRef}`;
  } else {
    oi.set('OutputConditionIdentifier', str(ctx.condition));
    how = `registered condition '${ctx.condition}'`;
  }
  // Replace any non-conformant PDF/X intents; leave other subtypes (e.g. PDF/A) intact.
  const kept = intents.filter((e) => {
    const d = ctx.R(e);
    return !(isDict(d) && nameOf(ctx, d, 'S') === 'GTS_PDFX');
  });
  ctx.catalog.set('OutputIntents', [...kept, oi]);
  return [{ rule: 'OutputIntent', action: `Added a PDF/X OutputIntent (${how}).`, object }];
};

const trappedPass: Pass = (ctx) => {
  const info = ctx.doc.ensureInfo();
  const cur = ctx.R(info.get('Trapped'));
  const val = isName(cur) ? cur.name : undefined;
  if (val === 'True' || val === 'False') return [];
  const want = ctx.opts.trapped ?? 'False';
  info.set('Trapped', name(want));
  return [{ rule: 'Trapped', action: `Set /Info /Trapped to /${want}.` }];
};

const pageGeometryPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  for (const page of ctx.doc.Pages) {
    if (page.Dict.get('TrimBox') !== undefined && page.Dict.get('ArtBox') !== undefined) {
      page.Dict.delete('ArtBox');
      actions.push({ rule: 'PageGeometry', action: 'Removed /ArtBox (page also has /TrimBox).', page });
      continue;
    }
    if (page.Dict.get('TrimBox') !== undefined || page.Dict.get('ArtBox') !== undefined) continue;
    // The trim box must lie within the bleed box, so prefer it as the source:
    // taking the MediaBox would manufacture the very defect the validator
    // reports. MediaBox comes via the Page accessor, which resolves inheritance.
    const bleed = ctx.R(page.Dict.get('BleedBox'));
    const crop = ctx.R(page.Dict.get('CropBox'));
    const src = isArray(bleed) ? bleed : isArray(crop) ? crop : undefined;
    const box = src !== undefined ? [...src] : [...page.MediaBox];
    page.Dict.set('TrimBox', box);
    const from = isArray(bleed) ? '/BleedBox' : isArray(crop) ? '/CropBox' : '/MediaBox';
    actions.push({ rule: 'PageGeometry', action: `Added /TrimBox from the ${from}.`, page });
  }
  return actions;
};

/** Every annotation dict across all pages. */
function eachAnnotation(ctx: XCctx): { ref?: PdfRef; dict: PdfDict; page: Page }[] {
  const out: { ref?: PdfRef; dict: PdfDict; page: Page }[] = [];
  for (const page of ctx.doc.Pages) {
    const arr = ctx.R(page.Dict.get('Annots'));
    if (!isArray(arr)) continue;
    for (const a of arr) {
      const d = ctx.R(a);
      if (isDict(d)) out.push({ ref: isRef(a) ? a : undefined, dict: d, page });
    }
  }
  return out;
}

/** Drop `target` from its page's /Annots array. */
function removeAnnot(ctx: XCctx, page: Page, target: PdfDict): void {
  const arr = ctx.R(page.Dict.get('Annots'));
  if (!isArray(arr)) return;
  page.Dict.set('Annots', arr.filter((e) => ctx.R(e) !== target));
}

const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);

/** Mirrors the validator's rule: /FileAttachment is prohibited only at the
 *  levels that also prohibit embedded files, so X-4 keeps its attachments. */
function annotProhibited(ctx: XCctx, subtype: string): boolean {
  if (PROHIBITED_ANNOTS.has(subtype)) return true;
  return subtype === 'FileAttachment' && isLegacy(ctx.level);
}

const annotationPass: Pass = (ctx) => {
  if (ctx.preserve.has('multimedia')) return [];
  const actions: ConvertAction[] = [];
  for (const { ref: object, dict, page } of eachAnnotation(ctx)) {
    const sub = nameOf(ctx, dict, 'Subtype');
    if (sub !== undefined && annotProhibited(ctx, sub)) {
      removeAnnot(ctx, page, dict);
      actions.push({ rule: 'Annotations', action: `Removed prohibited /${sub} annotation.`, object, page });
    }
  }
  return actions;
};

const PROHIBITED_ACTIONS = new Set([
  'JavaScript', 'Launch', 'Movie', 'Sound', 'ImportData', 'ResetForm', 'URI',
]);

/** True when the action (or anything in its /Next chain) is prohibited. */
function isProhibitedAction(ctx: XCctx, actionObj: PdfObject | undefined, seen = new Set<PdfDict>()): boolean {
  const a = ctx.R(actionObj);
  if (!isDict(a) || seen.has(a)) return false;
  seen.add(a);
  const s = nameOf(ctx, a, 'S');
  if (s !== undefined && PROHIBITED_ACTIONS.has(s)) return true;
  const next = ctx.R(a.get('Next'));
  if (isArray(next)) return next.some((n) => isProhibitedAction(ctx, n, seen));
  return isProhibitedAction(ctx, a.get('Next'), seen);
}

const actionsPass: Pass = (ctx) => {
  if (ctx.preserve.has('javascript')) return [];
  const actions: ConvertAction[] = [];
  if (isProhibitedAction(ctx, ctx.catalog.get('OpenAction'))) {
    ctx.catalog.delete('OpenAction');
    actions.push({ rule: 'Actions', action: 'Removed the prohibited catalog /OpenAction.' });
  }
  const aa = ctx.R(ctx.catalog.get('AA'));
  if (isDict(aa)) {
    let removed = 0;
    for (const k of [...aa.keys()]) {
      if (isProhibitedAction(ctx, aa.get(k))) { aa.delete(k); removed++; }
    }
    if (aa.size === 0) ctx.catalog.delete('AA');
    if (removed > 0) {
      actions.push({ rule: 'Actions', action: `Removed ${removed} prohibited catalog /AA entr${removed === 1 ? 'y' : 'ies'}.` });
    }
  }
  for (const { ref: object, dict, page } of eachAnnotation(ctx)) {
    if (isProhibitedAction(ctx, dict.get('A'))) {
      dict.delete('A');
      actions.push({ rule: 'Actions', action: 'Removed a prohibited annotation /A action.', object, page });
    }
    const annotAa = ctx.R(dict.get('AA'));
    if (isDict(annotAa)) {
      for (const k of [...annotAa.keys()]) {
        if (isProhibitedAction(ctx, annotAa.get(k))) annotAa.delete(k);
      }
      if (annotAa.size === 0) dict.delete('AA');
    }
  }
  return actions;
};

const optionalContentPass: Pass = (ctx) => {
  if (!isLegacy(ctx.level)) return []; // X-4 permits layers
  if (ctx.preserve.has('optionalContent')) return [];
  if (ctx.catalog.get('OCProperties') === undefined) return [];
  ctx.catalog.delete('OCProperties');
  return [{ rule: 'OptionalContent', action: 'Removed catalog /OCProperties.' }];
};

const embeddedFilesPass: Pass = (ctx) => {
  if (!isLegacy(ctx.level)) return []; // X-4 permits embedded files
  if (ctx.preserve.has('embeddedFiles')) return [];
  const names = ctx.R(ctx.catalog.get('Names'));
  if (!isDict(names) || names.get('EmbeddedFiles') === undefined) return [];
  names.delete('EmbeddedFiles');
  if (names.size === 0) ctx.catalog.delete('Names');
  return [{ rule: 'EmbeddedFiles', action: 'Removed the /Names /EmbeddedFiles tree.' }];
};

/** Every distinct ExtGState dict from page and Form XObject resources. */
function extGStates(ctx: XCctx): PdfDict[] {
  const out: PdfDict[] = [];
  const seen = new Set<PdfDict>();
  const seenRes = new Set<PdfDict>();
  const visit = (resObj: PdfObject | undefined): void => {
    const res = ctx.R(resObj);
    if (!isDict(res) || seenRes.has(res)) return;
    seenRes.add(res);
    const egs = ctx.R(res.get('ExtGState'));
    if (isDict(egs)) for (const v of egs.values()) {
      const d = ctx.R(v);
      if (isDict(d) && !seen.has(d)) { seen.add(d); out.push(d); }
    }
    const xobjs = ctx.R(res.get('XObject'));
    if (isDict(xobjs)) for (const v of xobjs.values()) {
      const x = ctx.R(v);
      if (isStream(x)) visit(x.dict.get('Resources'));
    }
  };
  for (const page of ctx.doc.Pages) visit(page.Resources);
  return out;
}

const ALLOWED_HALFTONE_TYPES = new Set([1, 5]);

const transferHalftonePass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  for (const dict of extGStates(ctx)) {
    for (const k of ['TR', 'TR2', 'HTP']) {
      if (dict.get(k) !== undefined) {
        dict.delete(k);
        actions.push({ rule: 'TransferHalftone', action: `Removed ExtGState /${k}.` });
      }
    }
    const ht = ctx.R(dict.get('HT'));
    const htDict = isStream(ht) ? ht.dict : isDict(ht) ? ht : undefined;
    if (htDict) {
      const t = ctx.R(htDict.get('HalftoneType'));
      if (typeof t === 'number' && !ALLOWED_HALFTONE_TYPES.has(t)) {
        dict.delete('HT');
        actions.push({ rule: 'TransferHalftone', action: `Removed a type-${t} halftone.` });
      }
    }
  }
  return actions;
};

/** Opt-in and lossy: rewrite DeviceRGB color operators to DeviceCMYK. Without
 *  the destination profile the ink values are not colorimetrically correct, so
 *  this is unsuitable for color-critical work. Raster images are not touched
 *  and still report unresolved. */
const colorPass: Pass = (ctx) => {
  if (!ctx.opts.convertColor) return [];
  const actions: ConvertAction[] = [];
  for (const page of ctx.doc.Pages) {
    const changed = rewriteRgbToCmyk(ctx.doc, page);
    if (changed > 0) {
      actions.push({ rule: 'ProhibitedColor', page,
        action: `Rewrote ${changed} DeviceRGB colour operator(s) to DeviceCMYK (approximate).` });
    }
  }
  return actions;
};

const PASSES: Pass[] = [
  identificationPass, versionPass, fileIdPass, outputIntentPass, trappedPass,
  pageGeometryPass, annotationPass, actionsPass, optionalContentPass,
  embeddedFilesPass, transferHalftonePass, colorPass,
];
