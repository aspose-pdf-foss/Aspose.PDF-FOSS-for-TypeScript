import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef, isName, isDict, isArray, isRef, isStream, isString, name,
} from './types.js';
import type { Page } from './page.js';
import { type ValidationIssue } from './validation.js';
import type { ConvertAction, ConversionReport } from './conversion.js';
export type { ConvertAction, ConversionReport } from './conversion.js';
import {
  validatePdfA, parseLevel, destProfileRefExempt, widgetActionKeys, type PdfALevel,
  pdfaIntentColorSpace, pageScans,
} from './pdfavalidate.js';
import type { Ctx as ScanCtx } from './validatectx.js';
import { convertColors } from './colorconvert.js';
import { hasSignatureField } from './signature.js';
import { usesTransparency } from './pdfatransparency.js';
import { srgbIcc, SRGB_N } from './srgb.js';
import { baseEncodingByName, glyphToUnicode } from './encoding.js';

export type ConvertCategory =
  | 'javascript' | 'multimedia' | 'embeddedFiles' | 'xfa' | 'optionalContent'
  | 'postScript' | 'info' | 'formActions' | 'deviceColor' | 'transparency';

export interface ConvertOptions {
  /** Output-intent ICC profile. Defaults to a bundled sRGB profile. */
  iccProfile?: { bytes: Uint8Array; n: 1 | 3 | 4; identifier?: string };
  /** Destructive-removal categories to skip (then reported unresolved). */
  preserve?: ConvertCategory[];
}


export interface Cctx {
  doc: Document;
  catalog: PdfDict;
  part: 1 | 2 | 3 | 4;
  level: 'b' | 'u' | 'a' | '' | 'e' | 'f';
  preserve: Set<ConvertCategory>;
  icc: { bytes: Uint8Array; n: 1 | 3 | 4; identifier: string };
  R(o: PdfObject | undefined): PdfObject;
}

type Pass = (ctx: Cctx) => ConvertAction[];

/** Remediate `doc` toward PDF/A `level`, then re-validate. The facade supplies
 *  the catalog (mirrors validatePdfA). Mutates the live model in place. */
export function convertToPdfA(
  doc: Document, catalog: PdfDict, level: PdfALevel, opts: ConvertOptions = {},
): ConversionReport {
  const { part, level: lvl } = parseLevel(level);
  const ic = opts.iccProfile ?? { bytes: srgbIcc(), n: SRGB_N as 3, identifier: 'sRGB' };
  const ctx: Cctx = {
    doc, catalog, part, level: lvl,
    preserve: new Set(opts.preserve ?? []),
    icc: { bytes: ic.bytes, n: ic.n, identifier: ic.identifier ?? 'Custom' },
    R: (o) => doc.resolve(o),
  };
  const applied: ConvertAction[] = [];
  for (const pass of PASSES) applied.push(...pass(ctx));
  const unresolved = validatePdfA(doc, catalog, level).Errors;
  return { applied, unresolved, passed: unresolved.length === 0 };
}

/** The name value of dict.get(key), resolved, or undefined. */
function nameOf(ctx: Cctx, dict: PdfDict, key: string): string | undefined {
  const v = ctx.R(dict.get(key));
  return isName(v) ? v.name : undefined;
}

// ---- passes ----------------------------------------------------------------

/** The pdfaid:conformance to write. PDF/A-4's base conformance is spelled by
 *  ABSENCE (ISO 19005-4 6.7.3-3), and `null` is how mergeXmp deletes a field —
 *  `ctx.level.toUpperCase()` would write `pdfaid:conformance=""`, which is the
 *  precise thing the part-4 refusal this replaced existed to prevent. */
function conformanceUpdate(ctx: Cctx): string | null {
  if (ctx.part !== 4) return ctx.level.toUpperCase();       // 'B' | 'U' | 'A'
  return ctx.level === '' ? null : ctx.level.toUpperCase(); // 'E' | 'F'
}

/** Write identification XMP (pdfaid + /Info mirror) via the facade.
 *
 *  Ordering invariant: this MUST run before infoPass. It reads /Info through
 *  GetMetadata() to mirror the fields into XMP, and at part 4 infoPass then
 *  strips or deletes that dictionary — strip it first and the mirror silently
 *  comes out empty, a loss invisible in the converted file, which validates
 *  either way. The /ModDate mirror is part-4 ONLY, because it exists to rescue
 *  the one field PDF/A-4 would otherwise permit and this conversion removes;
 *  mirroring it at parts 1-3 would move bytes for every existing caller. */
const identificationPass: Pass = (ctx) => {
  const conf = conformanceUpdate(ctx);
  const info = ctx.doc.GetMetadata();
  ctx.doc.SetXmp({
    pdfaPart: ctx.part,
    pdfaConformance: conf,
    ...(ctx.part === 4 ? { pdfaRev: 2020 } : {}),
    ...(info.title !== undefined ? { title: info.title } : {}),
    ...(info.author !== undefined ? { authors: [info.author] } : {}),
    ...(info.subject !== undefined ? { description: info.subject } : {}),
    ...(info.keywords !== undefined ? { keywords: info.keywords } : {}),
    ...(ctx.part === 4 && info.modDate !== undefined ? { modifyDate: info.modDate } : {}),
  });
  const idPart = conf === null ? `part ${ctx.part} (no conformance)` : `part ${ctx.part}/conformance ${conf}`;
  return [{ rule: 'PdfaIdentification', action: `Wrote pdfaid:${idPart}${ctx.part === 4 ? '/rev 2020' : ''} and mirrored /Info into XMP.` }];
};

/** Declare the part's version in the catalog. This is unconditional: the
 *  serializer emits the catalog /Version as the `%PDF-x.y` header and defaults
 *  to 1.7 without it, so a converted file would otherwise breach its own rule
 *  no matter what the input header said.
 *
 *  Note part 4 is NOT a ceiling but an exact major (ISO 19005-4 6.1.2-1): a
 *  perfectly good PDF 1.7 file is simply not PDF/A-4, so the value is raised
 *  here where parts 1-3 lower it. */
const versionPass: Pass = (ctx) => {
  const target = ctx.part === 4 ? '2.0' : ctx.part === 1 ? '1.4' : '1.7';
  if (nameOf(ctx, ctx.catalog, 'Version') === target) return [];
  ctx.catalog.set('Version', name(target));
  return [{ rule: 'Version', action: `Set catalog /Version to ${target}.` }];
};

/** PDF/A-4 near-bans the document information dictionary: ISO 19005-4 6.1.3-4
 *  permits /Info only alongside a catalog /PieceInfo, and 6.1.3-5 then allows
 *  it to hold nothing but /ModDate. Essentially every real document carries a
 *  title, author, producer and dates, so converting one to PDF/A-4 destroys
 *  that dictionary; the `'info'` category is how a caller declines the trade
 *  and takes an unresolved InfoRestriction instead.
 *
 *  Note the two branches are NOT alternatives to pick between. Reducing to
 *  /ModDate is legal ONLY beside a /PieceInfo: infoRestrictionRule reports a
 *  present /Info without one whatever it holds, so a reduce-only pass could
 *  never reach passed === true for a document that has no /PieceInfo. Deleting
 *  discards nothing, because identificationPass has already mirrored the title,
 *  author, subject, keywords AND /ModDate into XMP - which is where PDF 2.0
 *  wants them, and why identificationPass must run first.
 *
 *  Note it must run even for a document that HAD no /Info: SetXmp calls
 *  ensureInfo() unconditionally, so identificationPass itself creates an empty
 *  one, and an empty /Info with no /PieceInfo is still an error. */
const infoPass: Pass = (ctx) => {
  if (ctx.part !== 4 || ctx.preserve.has('info')) return [];
  const infoObj = ctx.doc.trailer.get('Info');
  if (infoObj === undefined) return [];
  const info = ctx.R(infoObj);
  if (!isDict(info)) return [];
  const object = isRef(infoObj) ? infoObj : undefined;

  if (ctx.catalog.get('PieceInfo') !== undefined) {
    const dropped = [...info.keys()].filter((k) => k !== 'ModDate');
    if (dropped.length === 0) return [];
    for (const k of dropped) info.delete(k);
    return [{ rule: 'InfoRestriction', object,
      action: `Reduced /Info to /ModDate (dropped ${dropped.map((k) => `/${k}`).join(', ')}).` }];
  }

  ctx.doc.trailer.delete('Info');
  if (isRef(infoObj)) ctx.doc.deleteObject(infoObj.num);
  return [{ rule: 'InfoRestriction', action:
    'Removed the document information dictionary (PDF/A-4 permits one only alongside a catalog /PieceInfo); its fields were mirrored into XMP first.' }];
};

/** Ensure the trailer carries an /ID. */
const fileIdPass: Pass = (ctx) => {
  const id = ctx.doc.trailer.get('ID');
  if (isArray(id) && id.length === 2) return [];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = (i * 37 + 11) & 0xff;
  const s = { kind: 'string' as const, bytes };
  ctx.doc.trailer.set('ID', [s, s]);
  return [{ rule: 'FileID', action: 'Generated a trailer /ID.' }];
};

/** Add a PDF/A OutputIntent with an ICC DestOutputProfile when none exists. */
const outputIntentPass: Pass = (ctx) => {
  const existing = ctx.R(ctx.catalog.get('OutputIntents'));
  if (isArray(existing)) {
    const hasPdfa = existing.some((e) => {
      const oi = ctx.R(e);
      return isDict(oi) && nameOf(ctx, oi, 'S') === 'GTS_PDFA1' && oi.get('DestOutputProfile') !== undefined;
    });
    if (hasPdfa) return [];
  }
  const profile: PdfDict = new Map<string, PdfObject>([
    ['N', ctx.icc.n],
    ['Length', ctx.icc.bytes.length],
  ]);
  const profileRef = ctx.doc.allocObject({ kind: 'stream', dict: profile, raw: ctx.icc.bytes });
  const oi: PdfDict = new Map<string, PdfObject>([
    ['Type', name('OutputIntent')],
    ['S', name('GTS_PDFA1')],
    ['OutputConditionIdentifier', { kind: 'string', bytes: new TextEncoder().encode(ctx.icc.identifier) }],
    ['DestOutputProfile', profileRef],
  ]);
  const arr = isArray(existing) ? [...existing, oi] : [oi];
  ctx.catalog.set('OutputIntents', arr);
  return [{ rule: 'OutputIntent', action: `Added ${ctx.icc.identifier} OutputIntent.`, object: profileRef }];
};

/**
 * Normalise device colour to the output intent's own space (`ixxw.2`).
 *
 * MUST run after `outputIntentPass`, which is what decides the intent this
 * aims at — for a document that had none, the sRGB profile that pass just
 * added.
 *
 * **It converts only toward an RGB intent**, and that is a decision rather
 * than a limitation. Converting to RGB uses the same pivot `raster.ts`
 * applies, so the rendered page is unchanged, which is this issue's whole
 * acceptance criterion. Converting to CMYK would mean naive maximum-black ink
 * with no destination profile — which `ConvertToPdfX` deliberately refuses to
 * do without an opt-in — and converting to GRAY destroys colour outright.
 * Under either, the content is left alone and `deviceColorRule` reports it,
 * which is the honest answer rather than a silent appearance change.
 *
 * The trigger is DeviceCMYK in a page scan, matching exactly what
 * `deviceColorRule` would report: DeviceGray is satisfied by any intent and
 * DeviceRGB already matches, so neither needs anything. Note the walk then
 * converts the WHOLE document, so DeviceGray content in a page that also uses
 * CMYK is rewritten to DeviceRGB too — appearance-identical and still
 * conformant, just more than the trigger strictly asked for.
 */
const deviceColorPass: Pass = (ctx) => {
  if (ctx.preserve.has('deviceColor')) return [];
  // `convertColors` throws on a signed document. ConvertToPdfA has never
  // refused one, and making it start throwing here would be a behaviour
  // change well beyond this pass; the validator reports what is left.
  if (hasSignatureField(ctx.doc)) return [];
  const scan: ScanCtx = {
    doc: ctx.doc, catalog: ctx.catalog, R: ctx.R, cache: new Map(),
  };
  if (pdfaIntentColorSpace(scan) !== 'RGB ') return [];
  if (!pageScans(scan).some((s) => s.colorSpaces.has('DeviceCMYK'))) return [];
  // `preserveSpotColors` because the point here is CONFORMANCE, not colour
  // reduction: a Separation is rebuilt over DeviceRGB rather than flattened,
  // so the named colorant a print workflow separates on survives (`ixxw.4`).
  const r = convertColors(ctx.doc, 'rgb', { preserveSpotColors: true });
  // The route names which of colorimage.ts's four paths each picture took —
  // a CMYK payload always takes decode-and-re-encode, since `jpeg-exact` is
  // gray-only by construction. `ixxw.3` asks for it in the report.
  const routes = [...new Set(r.images.map((i) => i.route))].sort();
  const via = routes.length > 0 ? ` via ${routes.join(', ')}` : '';
  return [{
    rule: 'DeviceColor',
    action: `Converted device colour to DeviceRGB to match the output intent `
      + `(${r.operators} operators, ${r.images.length} images${via}, ${r.shadings} shadings).`,
  }];
};

/**
 * Drop a page transparency group that provably does nothing (`ixxw.5`).
 *
 * Part 1 alone: parts 2/3/4 permit transparency outright, so there is no rule
 * to satisfy and removing the group would be a change nobody asked for.
 *
 * ISO 19005-1 prohibits transparency and this converter cannot FLATTEN it —
 * correctly, since flattening means rasterizing the page and losing its text.
 * But producers stamp `/Group /S /Transparency` on pages that use no
 * transparency at all, and such a group cannot change the rendered result, so
 * removing it costs nothing and is the difference between a document that
 * converts and one that does not.
 *
 * **Invariant:** the test is `usesTransparency`, which is deliberately
 * conservative — every ExtGState in a resource dictionary counts, read or not
 * — so a group survives whenever transparency cannot be ruled out. Real
 * transparency keeps its group and `transparencyRule` still reports it.
 *
 * **Note the scope, and it is deliberate:** PAGE groups only. A Form XObject's
 * own `/Group` is a disqualifier here rather than something to look inside,
 * which is the issue's own list; ruling a nested group inert is a separate
 * judgement, and a page holding one keeps its own group and is still reported.
 */
const inertTransparencyGroupPass: Pass = (ctx) => {
  if (ctx.part !== 1) return [];
  if (ctx.preserve.has('transparency')) return [];
  const actions: ConvertAction[] = [];
  for (const page of ctx.doc.Pages) {
    const grp = ctx.R(page.Dict.get('Group'));
    if (!isDict(grp) || nameOf(ctx, grp, 'S') !== 'Transparency') continue;
    // `page.Resources` is the INHERITED value: a group's resources are
    // routinely held on the /Pages node, and the raw read would rule a page
    // inert by failing to look at what it actually draws with.
    if (usesTransparency(page.Resources, ctx.R)) continue;
    page.Dict.delete('Group');
    actions.push({
      rule: 'Transparency',
      action: 'Removed an inert page transparency group (nothing it reaches uses transparency).',
    });
  }
  return actions;
};

/** Every annotation dict across all pages. */
function eachAnnotation(ctx: Cctx): { ref?: PdfRef; dict: PdfDict; page: Page }[] {
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

/** Set Print, clear Hidden/NoView/Invisible; set /CA->1 at part 1. */
const annotationFlagsPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  for (const { ref, dict, page } of eachAnnotation(ctx)) {
    if (nameOf(ctx, dict, 'Subtype') === 'Popup') continue;
    const f = ctx.R(dict.get('F'));
    const flags = typeof f === 'number' ? f : 0;
    // set Print(4); clear Invisible(1)/Hidden(2)/NoView(32), and at part 4 also
    // ToggleNoView(256), which ISO 19005-4 6.3.2-2 adds and parts 1-3 permit.
    const clear = ctx.part === 4 ? (1 | 2 | 32 | 256) : (1 | 2 | 32);
    const fixed = (flags | 4) & ~clear;
    if (fixed !== flags) {
      dict.set('F', fixed);
      actions.push({ rule: 'AnnotationFlags', action: 'Normalized annotation /F flags.', object: ref, page });
    }
    if (ctx.part === 1) {
      const ca = ctx.R(dict.get('CA'));
      if (typeof ca === 'number' && ca !== 1) {
        dict.set('CA', 1);
        actions.push({ rule: 'AnnotationOpacity', action: 'Set annotation /CA to 1.', object: ref, page });
      }
    }
  }
  return actions;
};

/** Generate field appearances and drop /NeedAppearances. */
const formsPass: Pass = (ctx) => {
  const acro = ctx.R(ctx.catalog.get('AcroForm'));
  if (!isDict(acro)) return [];
  ctx.doc.Form.GenerateAppearances(); // generates per-field /AP and deletes /NeedAppearances
  return [{ rule: 'NeedAppearances', action: 'Generated field appearances and cleared /NeedAppearances.' }];
};

const STANDARD_BLEND = new Set([
  'Normal', 'Compatible', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion',
  'Hue', 'Saturation', 'Color', 'Luminosity',
]);
const STANDARD_INTENTS = new Set(['AbsoluteColorimetric', 'RelativeColorimetric', 'Saturation', 'Perceptual']);

/** Every distinct ExtGState dict from page + Form XObject resources. */
function extGStates(ctx: Cctx): { ref?: PdfRef; dict: PdfDict }[] {
  const out: { ref?: PdfRef; dict: PdfDict }[] = [];
  const seen = new Set<PdfDict>();
  const seenRes = new Set<PdfDict>();
  const visit = (resObj: PdfObject | undefined): void => {
    const res = ctx.R(resObj);
    if (!isDict(res) || seenRes.has(res)) return;
    seenRes.add(res);
    const egs = ctx.R(res.get('ExtGState'));
    if (isDict(egs)) for (const v of egs.values()) {
      const d = ctx.R(v);
      if (isDict(d) && !seen.has(d)) { seen.add(d); out.push({ ref: isRef(v) ? v : undefined, dict: d }); }
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

/** Normalize ExtGState /BM, image /Interpolate, image /Intent, and symbolic TT /Encoding. */
const cosmeticPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];

  // ExtGState blend modes (resource-embedded, possibly inline).
  for (const { ref: object, dict } of extGStates(ctx)) {
    const bm = ctx.R(dict.get('BM'));
    const bmName = isName(bm) ? bm.name
      : isArray(bm) && isName(ctx.R(bm[0])) ? (ctx.R(bm[0]) as { name: string }).name : undefined;
    if (bmName && !STANDARD_BLEND.has(bmName)) {
      dict.set('BM', name('Normal'));
      actions.push({ rule: 'BlendMode', action: `Reset blend mode '${bmName}' to /Normal.`, object });
    }
  }

  // Image XObjects and fonts (indirect objects).
  for (const [object, obj] of ctx.doc.objectEntries()) {
    const dict = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (!dict) continue;
    const type = nameOf(ctx, dict, 'Type');
    const subtype = nameOf(ctx, dict, 'Subtype');

    // Image XObject /Interpolate and /Intent.
    if (subtype === 'Image') {
      if (ctx.R(dict.get('Interpolate')) === true) {
        dict.set('Interpolate', false);
        actions.push({ rule: 'ImageInterpolate', action: 'Set image /Interpolate to false.', object });
      }
      const intent = nameOf(ctx, dict, 'Intent');
      if (intent && !STANDARD_INTENTS.has(intent)) {
        dict.set('Intent', name('RelativeColorimetric'));
        actions.push({ rule: 'RenderingIntent', action: `Reset image /Intent '${intent}'.`, object });
      }
    }

    // Symbolic TrueType /Encoding.
    if (type === 'Font' && subtype === 'TrueType' && dict.get('Encoding') !== undefined) {
      const fd = ctx.R(dict.get('FontDescriptor'));
      const flags = isDict(fd) ? ctx.R(fd.get('Flags')) : undefined;
      const symbolic = typeof flags === 'number' && (flags & 4) !== 0 && (flags & 32) === 0;
      if (symbolic) {
        dict.delete('Encoding');
        actions.push({ rule: 'FontEncoding', action: 'Removed /Encoding from a symbolic TrueType font.', object });
      }
    }
  }
  return actions;
};

const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);

/** ISO 19005-4 6.3.1-1: FileAttachment joins the prohibited set. 3D and
 *  RichMedia come back off it at 4e — that allowance is most of what makes
 *  PDF/A-4e the engineering conformance. Mirrors pdfavalidate.ts's set. */
const PROHIBITED_ANNOTS_A4 = new Set([
  'Movie', 'Sound', 'Screen', '3D', 'RichMedia', 'FileAttachment',
]);

function prohibitedAnnots(ctx: Cctx): Set<string> {
  if (ctx.part !== 4) return PROHIBITED_ANNOTS;
  if (ctx.level !== 'e') return PROHIBITED_ANNOTS_A4;
  const s = new Set(PROHIBITED_ANNOTS_A4);
  s.delete('3D');
  s.delete('RichMedia');
  return s;
}

const PROHIBITED_ACTIONS = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript', 'SetState', 'Hide', 'SetOCGState',
]);

/** ISO 19005-4 6.6.1-1. Note what is ABSENT: JavaScript is PERMITTED in
 *  PDF/A-4, where parts 1-3 prohibit it — so conversion must stop removing it,
 *  and stop deleting the /Names /JavaScript tree with it. */
const PROHIBITED_ACTIONS_A4 = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide',
  'Rendition', 'Trans', 'SetOCGState', 'GoTo3DView', 'SetState', 'NoOp',
]);

/** The prohibited-action set for the target. PDF/A-4e re-permits SetOCGState
 *  and GoTo3DView, which is most of what makes it the engineering level. */
function prohibitedActions(ctx: Cctx): Set<string> {
  if (ctx.part !== 4) return PROHIBITED_ACTIONS;
  if (ctx.level !== 'e') return PROHIBITED_ACTIONS_A4;
  const s = new Set(PROHIBITED_ACTIONS_A4);
  s.delete('SetOCGState');
  s.delete('GoTo3DView');
  return s;
}

/** ISO 19005-4 6.6.3-1: the permitted additional-action triggers. */
const PERMITTED_AA_KEYS_A4 = new Set(['E', 'X', 'D', 'U', 'Fo', 'Bl']);

/** True when the named action dict is prohibited for this target. */
function isProhibitedAction(ctx: Cctx, actionObj: PdfObject | undefined): boolean {
  const a = ctx.R(actionObj);
  return isDict(a) && prohibitedActions(ctx).has(nameOf(ctx, a, 'S') ?? '');
}

/** Remove prohibited actions (and /AA at part 1). What counts as prohibited is
 *  the TARGET's set, so JavaScript survives at part 4 — including its /Names
 *  tree, which is gated on the same set rather than on the part number. */
const actionsPass: Pass = (ctx) => {
  if (ctx.preserve.has('javascript')) return [];
  const banned = prohibitedActions(ctx);
  const actions: ConvertAction[] = [];
  if (isProhibitedAction(ctx, ctx.catalog.get('OpenAction'))) {
    ctx.catalog.delete('OpenAction');
    actions.push({ rule: 'Actions', action: 'Removed prohibited /OpenAction.' });
  }
  const names = ctx.R(ctx.catalog.get('Names'));
  if (banned.has('JavaScript') && isDict(names) && names.get('JavaScript') !== undefined) {
    names.delete('JavaScript');
    actions.push({ rule: 'Actions', action: 'Removed /Names /JavaScript tree.' });
  }
  const stripAA = (dict: PdfDict, subtype?: string): void => {
    const aa = ctx.R(dict.get('AA'));
    if (!isDict(aa)) return;
    if (ctx.part === 1) { dict.delete('AA'); actions.push({ rule: 'AdditionalActions', action: 'Removed /AA.' }); return; }
    if (ctx.part === 4) {
      // 6.6.3-1 restricts the KEY SET rather than the action types, and exempts
      // Widget annotations, whose triggers are the form's.
      if (subtype !== 'Widget') {
        for (const k of [...aa.keys()]) {
          if (!PERMITTED_AA_KEYS_A4.has(k)) {
            aa.delete(k);
            actions.push({ rule: 'AdditionalActions', action: `Removed /AA /${k} (not one of E, X, D, U, Fo, Bl).` });
          }
        }
      }
    } else {
      for (const k of [...aa.keys()]) {
        if (isProhibitedAction(ctx, aa.get(k))) { aa.delete(k); actions.push({ rule: 'AdditionalActions', action: `Removed prohibited /AA /${k}.` }); }
      }
    }
    if (aa.size === 0) dict.delete('AA');
  };
  stripAA(ctx.catalog);
  for (const page of ctx.doc.Pages) stripAA(page.Dict);
  for (const { ref, dict } of eachAnnotation(ctx)) {
    if (isProhibitedAction(ctx, dict.get('A'))) {
      dict.delete('A');
      actions.push({ rule: 'Actions', action: 'Removed prohibited annotation /A.', object: ref });
    }
    stripAA(dict, nameOf(ctx, dict, 'Subtype'));
  }
  return actions;
};

/** Remove an annotation ref from every page's /Annots array. */
function removeAnnot(ctx: Cctx, target: PdfDict): void {
  for (const page of ctx.doc.Pages) {
    const arr = ctx.R(page.Dict.get('Annots'));
    if (!isArray(arr)) continue;
    const idx = arr.findIndex((a) => ctx.R(a) === target);
    if (idx >= 0) { arr.splice(idx, 1); if (arr.length === 0) page.Dict.delete('Annots'); }
  }
}

/** Remove prohibited annotation subtypes — the target's set, so part 4 also
 *  takes FileAttachment and 4e keeps 3D and RichMedia. */
const multimediaPass: Pass = (ctx) => {
  if (ctx.preserve.has('multimedia')) return [];
  const banned = prohibitedAnnots(ctx);
  const actions: ConvertAction[] = [];
  for (const { ref, dict, page } of eachAnnotation(ctx)) {
    const st = nameOf(ctx, dict, 'Subtype');
    if (st && banned.has(st)) {
      removeAnnot(ctx, dict);
      actions.push({ rule: 'AnnotationSubtype', action: `Removed /${st} annotation.`, object: ref, page });
    }
  }
  return actions;
};

/** Remove dynamic XFA. */
const xfaPass: Pass = (ctx) => {
  if (ctx.preserve.has('xfa')) return [];
  const acro = ctx.R(ctx.catalog.get('AcroForm'));
  if (isDict(acro) && acro.get('XFA') !== undefined) {
    acro.delete('XFA');
    return [{ rule: 'XFA', action: 'Removed /AcroForm /XFA.' }];
  }
  return [];
};

/** Remove optional content at part 1. */
const optionalContentPass: Pass = (ctx) => {
  if (ctx.part !== 1 || ctx.preserve.has('optionalContent')) return [];
  if (ctx.catalog.get('OCProperties') === undefined) return [];
  ctx.catalog.delete('OCProperties');
  return [{ rule: 'OptionalContent', action: 'Removed catalog /OCProperties.' }];
};

/** Embedded files: remove at part 1; set /AFRelationship at parts 2/3. */
const embeddedFilesPass: Pass = (ctx) => {
  if (ctx.preserve.has('embeddedFiles')) return [];
  const actions: ConvertAction[] = [];
  const names = ctx.R(ctx.catalog.get('Names'));
  if (ctx.part === 1) {
    if (isDict(names) && names.get('EmbeddedFiles') !== undefined) {
      names.delete('EmbeddedFiles');
      actions.push({ rule: 'EmbeddedFiles', action: 'Removed /Names /EmbeddedFiles (part 1).' });
    }
    for (const { ref, dict } of eachAnnotation(ctx)) {
      if (nameOf(ctx, dict, 'Subtype') === 'FileAttachment') {
        removeAnnot(ctx, dict);
        actions.push({ rule: 'EmbeddedFiles', action: 'Removed /FileAttachment annotation (part 1).', object: ref });
      }
    }
    return actions;
  }
  if (ctx.part === 4) {
    // ISO 19005-4 6.9-1/-2/-4. Note the direction: part 4 never REMOVES an
    // attachment — 4f is built on carrying one — so this only adds what the
    // clause newly requires, and is not gated on the 'embeddedFiles' preserve
    // category, which names destructive removals and has nothing to skip here.
    for (const [object, obj] of ctx.doc.objectEntries()) {
      if (!isDict(obj)) continue;
      if (nameOf(ctx, obj, 'Type') !== 'Filespec' || obj.get('EF') === undefined) continue;
      if (obj.get('AFRelationship') === undefined) {
        obj.set('AFRelationship', name('Unspecified'));
        actions.push({ rule: 'EmbeddedFileSpec', action: 'Set /AFRelationship on a file spec.', object });
      }
      const f = ctx.R(obj.get('F'));
      if (obj.get('UF') === undefined && isString(f)) {
        obj.set('UF', { kind: 'string' as const, bytes: f.bytes });
        actions.push({ rule: 'EmbeddedFileSpec', action: 'Copied /F to /UF on a file spec.', object });
      }
      const ef = ctx.R(obj.get('EF'));
      if (!isDict(ef)) continue;
      for (const v of ef.values()) {
        const stream = ctx.R(v);
        if (isStream(stream) && stream.dict.get('Subtype') === undefined) {
          // A MIME type is a NAME: build it from the RAW text and let
          // escapeName emit `/application#2foctet-stream`.
          stream.dict.set('Subtype', name('application/octet-stream'));
          actions.push({ rule: 'EmbeddedFileSpec', object: isRef(v) ? v : object,
            action: 'Set /Subtype application/octet-stream on an embedded file stream.' });
        }
      }
    }
    return actions;
  }
  // parts 2/3: ensure each file spec carries /AFRelationship.
  for (const [object, obj] of ctx.doc.objectEntries()) {
    if (!isDict(obj)) continue;
    if (nameOf(ctx, obj, 'Type') === 'Filespec' && obj.get('EF') !== undefined && obj.get('AFRelationship') === undefined) {
      obj.set('AFRelationship', name('Unspecified'));
      actions.push({ rule: 'EmbeddedFiles', action: 'Set /AFRelationship on a file spec.', object });
    }
  }
  return actions;
};

/** Remove PostScript XObjects from resources. */
const postScriptPass: Pass = (ctx) => {
  if (ctx.preserve.has('postScript')) return [];
  const actions: ConvertAction[] = [];
  for (const [, obj] of ctx.doc.objectEntries()) {
    const res = isStream(obj) ? ctx.R(obj.dict.get('Resources')) : isDict(obj) ? ctx.R(obj.get('Resources')) : undefined;
    const xobjs = isDict(res) ? ctx.R(res.get('XObject')) : undefined;
    if (!isDict(xobjs)) continue;
    for (const k of [...xobjs.keys()]) {
      const xoRef = xobjs.get(k);
      const xo = ctx.R(xoRef);
      if (isStream(xo) && nameOf(ctx, xo.dict, 'Subtype') === 'PS') {
        xobjs.delete(k);
        if (isRef(xoRef)) ctx.doc.deleteObject(xoRef.num); // drop the orphan so re-validation agrees
        actions.push({ rule: 'PostScriptXObject', action: `Removed PostScript XObject /${k}.` });
      }
    }
  }
  return actions;
};

/** Build a code->Unicode table for a simple font dict (base encoding + /Differences). */
function codeToUnicode(ctx: Cctx, fontDict: PdfDict): (string | undefined)[] {
  const enc = ctx.R(fontDict.get('Encoding'));
  let table: (string | undefined)[];
  if (isName(enc)) table = baseEncodingByName(enc.name).slice();
  else if (isDict(enc)) {
    const base = ctx.R(enc.get('BaseEncoding'));
    table = baseEncodingByName(isName(base) ? base.name : undefined).slice();
    const diffs = ctx.R(enc.get('Differences'));
    if (isArray(diffs)) {
      let code = 0;
      for (const it of diffs) {
        if (typeof it === 'number') code = it;
        else if (isName(it)) { table[code & 0xff] = glyphToUnicode(it.name) ?? table[code & 0xff]; code++; }
      }
    }
  } else {
    table = baseEncodingByName(undefined).slice();
  }
  return table;
}

/** Build a /ToUnicode CMap body for the given code->Unicode table. */
function toUnicodeCMap(table: (string | undefined)[]): string {
  const hex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join('');
  const entries: string[] = [];
  for (let code = 0; code < 256; code++) {
    const u = table[code];
    if (u && u.length) entries.push(`<${code.toString(16).padStart(2, '0')}> <${hex(u)}>`);
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n`
    + `/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n`
    + `/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n`
    + `1 begincodespacerange\n<00> <ff>\nendcodespacerange\n`
    + `${entries.length} beginbfchar\n${entries.join('\n')}\nendbfchar\n`
    + `endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

/** Synthesize /ToUnicode for simple fonts that lack it (level u/a only). */
const toUnicodePass: Pass = (ctx) => {
  if (ctx.level === 'b') return [];
  const actions: ConvertAction[] = [];
  const seen = new Set<PdfDict>();
  const handle = (fontDict: PdfDict, fontRef?: PdfRef): void => {
    if (seen.has(fontDict)) return;
    seen.add(fontDict);
    const sub = nameOf(ctx, fontDict, 'Subtype');
    if (sub === 'Type0' || sub === 'Type3') return;       // Type0 needs a CMap; Type3 has none
    if (fontDict.get('ToUnicode') !== undefined) return;
    const table = codeToUnicode(ctx, fontDict);
    if (!table.some((u) => u && u.length)) return;          // nothing resolvable -> leave unresolved
    const body = new TextEncoder().encode(toUnicodeCMap(table));
    const streamDict: PdfDict = new Map<string, PdfObject>([['Length', body.length]]);
    const ref = ctx.doc.allocObject({ kind: 'stream', dict: streamDict, raw: body });
    fontDict.set('ToUnicode', ref);
    actions.push({ rule: 'ToUnicode', action: 'Synthesized /ToUnicode CMap.', object: fontRef });
  };
  const seenRes = new Set<PdfDict>();
  const visit = (resObj: PdfObject | undefined): void => {
    const res = ctx.R(resObj);
    if (!isDict(res) || seenRes.has(res)) return;
    seenRes.add(res);
    const fonts = ctx.R(res.get('Font'));
    if (isDict(fonts)) for (const v of fonts.values()) { const d = ctx.R(v); if (isDict(d)) handle(d, isRef(v) ? v : undefined); }
    const xobjs = ctx.R(res.get('XObject'));
    if (isDict(xobjs)) for (const v of xobjs.values()) { const x = ctx.R(v); if (isStream(x)) visit(x.dict.get('Resources')); }
  };
  for (const page of ctx.doc.Pages) visit(page.Resources);
  return actions;
};

// ---- PDF/A-4 (ISO 19005-4) passes ------------------------------------------

/** ISO 19005's catalog prohibitions: /NeedsRendering (6.4.2), /Requirements
 *  (6.12), /Names /AlternatePresentations and page /PresSteps (6.11), and every
 *  /Perms key but /DocMDP (6.1.11). All name behaviour a conforming reader must
 *  not have rather than content the page draws, so none is gated on a preserve
 *  category. */
const catalogKeysPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];

  // /NeedsRendering is the ONE key here the older parts also prohibit
  // (ISO 19005-2/-3 6.4.2-2), so it is scoped per key rather than the pass
  // being gated whole — which is what left it detected-but-unrepaired at parts
  // 2/3 when the rule widened, found by the messy-document acceptance case.
  const keys = ctx.part === 4 ? ['NeedsRendering', 'Requirements'] as const
    : ctx.part === 1 ? [] as const
      : ['NeedsRendering'] as const;
  for (const key of keys) {
    if (ctx.catalog.get(key) !== undefined) {
      ctx.catalog.delete(key);
      actions.push({ rule: key, action: `Removed catalog /${key}.` });
    }
  }
  // Everything below is part-4-only: /Requirements above, and these three.
  if (ctx.part !== 4) return actions;

  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('AlternatePresentations') !== undefined) {
    names.delete('AlternatePresentations');
    actions.push({ rule: 'AlternatePresentations', action: 'Removed /Names /AlternatePresentations.' });
  }
  for (const page of ctx.doc.Pages) {
    if (page.Dict.get('PresSteps') !== undefined) {
      page.Dict.delete('PresSteps');
      actions.push({ rule: 'AlternatePresentations', action: 'Removed page /PresSteps.', page });
    }
  }

  const perms = ctx.R(ctx.catalog.get('Perms'));
  if (isDict(perms)) {
    for (const k of [...perms.keys()]) {
      if (k === 'DocMDP') continue;
      perms.delete(k);
      actions.push({ rule: 'Permissions', action: `Removed catalog /Perms /${k}.` });
    }
    if (perms.size === 0) ctx.catalog.delete('Perms');
  }
  return actions;
};

/** Transfer functions and halftones (ISO 19005-1 6.2.8 / -2/-3 6.2.5 / -4
 *  6.2.5), the image keys (6.2.4 / 6.2.8 / 6.2.7.1) and Form XObject /OPI
 *  (6.2.4 / 6.2.9 / 6.2.8.1). Renamed off the `pdfa4` prefix in `pjy7`, which
 *  became a lie the moment it ran at part 2.
 *
 *  Invariant: the per-part scope matches the RULES' — /HTO at part 4 only,
 *  halftones from part 2, the rest everywhere. A pass that decided
 *  independently which parts it serves is how a converter comes to fix
 *  something the validator does not report, or leave something it does.
 *
 *  Note what is NOT fixed and why: a halftone TYPE outside {1,5} and a
 *  /BitsPerComponent outside the permitted set would need the page to print
 *  differently or the image re-encoded, so they are left for the re-validation
 *  to report. */
const graphicsKeysPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];

  for (const { ref: object, dict } of extGStates(ctx)) {
    // /HTO is a PDF 2.0 key and appears in the part-4 profile alone.
    for (const k of ctx.part === 4 ? ['TR', 'HTO'] : ['TR']) {
      if (dict.get(k) !== undefined) {
        dict.delete(k);
        actions.push({ rule: 'ExtGStateKeys', action: `Removed ExtGState /${k}.`, object });
      }
    }
    // 6.2.5-2: /TR2 survives, but only as /Default - so it is SET, not deleted.
    if (dict.get('TR2') !== undefined && nameOf(ctx, dict, 'TR2') !== 'Default') {
      dict.set('TR2', name('Default'));
      actions.push({ rule: 'ExtGStateKeys', action: 'Set ExtGState /TR2 to /Default.', object });
    }
    // The halftone rules start at part 2; repairing at part 1 would "fix" what
    // ISO 19005-1 permits.
    const ht = ctx.part === 1 ? undefined : ctx.R(dict.get('HT'));
    if (isDict(ht) && ht.get('HalftoneName') !== undefined) {
      ht.delete('HalftoneName');
      actions.push({ rule: 'Halftone', action: 'Removed /HalftoneName from a halftone dictionary.', object });
    }
  }

  for (const [object, obj] of ctx.doc.objectEntries()) {
    if (!isStream(obj)) continue;
    const subtype = nameOf(ctx, obj.dict, 'Subtype');
    if (subtype === 'Image') {
      for (const k of ['Alternates', 'OPI']) {
        if (obj.dict.get(k) !== undefined) {
          obj.dict.delete(k);
          actions.push({ rule: 'ImageKeys', action: `Removed image /${k}.`, object });
        }
      }
    } else if (subtype === 'Form' && obj.dict.get('OPI') !== undefined) {
      obj.dict.delete('OPI');
      actions.push({ rule: 'FormXObjectOpi', action: 'Removed Form XObject /OPI.', object });
    }
  }
  return actions;
};

/** ISO 19005-2/-3 6.2.3-3 and -4 6.2.3-3: no /DestOutputProfileRef, which names
 *  a profile the file does not carry. Registered AFTER outputIntentPass, which
 *  may add an intent — policing the array before it is populated polices the
 *  wrong array.
 *
 *  Invariant: the GTS_PDFX exemption comes from `destProfileRefExempt`, the
 *  same helper the rule reads, so the pass cannot strip a key the validator
 *  permits. The surplus-intent drop stays part-4-only for the same reason. */
const outputIntentKeysPass: Pass = (ctx) => {
  if (ctx.part === 1) return [];
  const ois = ctx.R(ctx.catalog.get('OutputIntents'));
  if (!isArray(ois)) return [];
  const actions: ConvertAction[] = [];
  const kept: PdfObject[] = [];
  let seenPdfa = false;
  for (const e of ois) {
    const oi = ctx.R(e);
    if (!isDict(oi)) { kept.push(e); continue; }
    const object = isRef(e) ? e : undefined;
    const s = nameOf(ctx, oi, 'S');
    if (oi.get('DestOutputProfileRef') !== undefined && !destProfileRefExempt(ctx.part, s)) {
      oi.delete('DestOutputProfileRef');
      actions.push({ rule: 'OutputIntentKeys', action: 'Removed OutputIntent /DestOutputProfileRef.', object });
    }
    if (s === 'GTS_PDFA1') {
      if (ctx.part === 4 && seenPdfa) {
        actions.push({ rule: 'OutputIntentKeys', object,
          action: 'Dropped a surplus PDF/A OutputIntent (at most one is permitted).' });
        continue;
      }
      seenPdfa = true;
    }
    kept.push(e);
  }
  if (kept.length !== ois.length) ctx.catalog.set('OutputIntents', kept);
  return actions;
};

/** An appearance dictionary may hold only /N (ISO 19005-1 6.5.3-4, -2/-3
 *  6.3.3-2, -4 6.3.3-1), and a Widget may carry no action (19005-1 6.6.1-3 and
 *  6.6.2-1, -2/-3 6.4.1-1, -4 6.4.1-1). Registered after formsPass, which
 *  generates the /AP dictionaries this then prunes.
 *
 *  Note the asymmetry between the two halves, and it is why only one is gated
 *  on a category: pruning /AP is non-destructive normalisation — a /D or /R
 *  entry is alternate ARTWORK for a state the document may never reach — while
 *  stripping a Widget's /A and /AA deletes real behaviour: a push button's
 *  action, a field's keystroke and format scripts.
 *
 *  Invariant: WHICH keys go comes from `widgetActionKeys`, the same helper the
 *  rule reads, so part 4 keeps its 6.6.3-1 exemption for /AA here too. */
const annotKeysPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  const keys = ctx.preserve.has('formActions') ? [] : widgetActionKeys(ctx.part);
  for (const { ref: object, dict, page } of eachAnnotation(ctx)) {
    const ap = ctx.R(dict.get('AP'));
    if (isDict(ap)) {
      for (const k of [...ap.keys()]) {
        if (k === 'N') continue;
        ap.delete(k);
        actions.push({ rule: 'AppearanceKeys', action: `Removed appearance /${k}.`, object, page });
      }
    }
    if (nameOf(ctx, dict, 'Subtype') !== 'Widget') continue;
    for (const k of keys) {
      if (dict.get(k) === undefined) continue;
      dict.delete(k);
      actions.push({ rule: 'WidgetAction', action: `Removed /${k} from a Widget annotation.`, object, page });
    }
  }
  return actions;
};

/** ISO 19005-4 6.10-1/-2: every optional-content configuration needs a /Name,
 *  and the names must be unique. Only the missing-name half is remediable — the
 *  names already in use are collected first, so this pass cannot MANUFACTURE
 *  the duplicate the same clause forbids. */
const ocConfigPass: Pass = (ctx) => {
  if (ctx.part !== 4) return [];
  const ocp = ctx.R(ctx.catalog.get('OCProperties'));
  if (!isDict(ocp)) return [];
  const configs: PdfDict[] = [];
  const d = ctx.R(ocp.get('D'));
  if (isDict(d)) configs.push(d);
  const alt = ctx.R(ocp.get('Configs'));
  if (isArray(alt)) for (const c of alt) { const cd = ctx.R(c); if (isDict(cd)) configs.push(cd); }

  const used = new Set<string>();
  for (const cfg of configs) {
    const nm = ctx.R(cfg.get('Name'));
    if (isString(nm)) used.add(new TextDecoder('latin1').decode(nm.bytes));
  }

  const actions: ConvertAction[] = [];
  for (const cfg of configs) {
    if (isString(ctx.R(cfg.get('Name')))) continue;
    let label = 'Default';
    for (let i = 2; used.has(label); i++) label = `Default ${i}`;
    used.add(label);
    cfg.set('Name', { kind: 'string' as const, bytes: new TextEncoder().encode(label) });
    actions.push({ rule: 'OcConfig', action: `Named an optional-content configuration '${label}'.` });
  }
  return actions;
};

const PASSES: Pass[] = [
  identificationPass, versionPass, fileIdPass, outputIntentPass,
  // Immediately after outputIntentPass, which decides the space it aims at.
  deviceColorPass,
  inertTransparencyGroupPass,
  annotationFlagsPass, formsPass, cosmeticPass,
  actionsPass, multimediaPass, xfaPass, optionalContentPass, embeddedFilesPass, postScriptPass,
  toUnicodePass,
  // Widened to parts 1-3 in pjy7; only catalogKeysPass's tail and ocConfigPass are
  // still part-4-only, so only they keep the part in their name.
  graphicsKeysPass, outputIntentKeysPass, annotKeysPass,
  catalogKeysPass, ocConfigPass,
  // LAST, and deliberately: identificationPass reads /Info through
  // GetMetadata() and SetXmp's mirror writes it back, so anything that strips
  // /Info must follow every pass that could touch it.
  infoPass,
];
