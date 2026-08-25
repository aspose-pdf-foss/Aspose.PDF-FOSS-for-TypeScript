import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef, isName, isDict, isArray, isRef, isStream, name,
} from './types.js';
import type { Page } from './page.js';
import { type ValidationIssue } from './validation.js';
import type { ConvertAction, ConversionReport } from './conversion.js';
export type { ConvertAction, ConversionReport } from './conversion.js';
import { validatePdfA, parseLevel, type PdfALevel } from './pdfavalidate.js';
import { srgbIcc, SRGB_N } from './srgb.js';
import { baseEncodingByName, glyphToUnicode } from './encoding.js';

export type ConvertCategory =
  | 'javascript' | 'multimedia' | 'embeddedFiles' | 'xfa' | 'optionalContent' | 'postScript';

export interface ConvertOptions {
  /** Output-intent ICC profile. Defaults to a bundled sRGB profile. */
  iccProfile?: { bytes: Uint8Array; n: 1 | 3 | 4; identifier?: string };
  /** Destructive-removal categories to skip (then reported unresolved). */
  preserve?: ConvertCategory[];
}


export interface Cctx {
  doc: Document;
  catalog: PdfDict;
  part: 1 | 2 | 3;
  level: 'b' | 'u' | 'a';
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

/** Write identification XMP (pdfaid + /Info mirror) via the facade. */
const identificationPass: Pass = (ctx) => {
  const conf = ctx.level.toUpperCase(); // 'B' | 'U' | 'A'
  const info = ctx.doc.GetMetadata();
  ctx.doc.SetXmp({
    pdfaPart: ctx.part,
    pdfaConformance: conf,
    ...(info.title !== undefined ? { title: info.title } : {}),
    ...(info.author !== undefined ? { authors: [info.author] } : {}),
    ...(info.subject !== undefined ? { description: info.subject } : {}),
    ...(info.keywords !== undefined ? { keywords: info.keywords } : {}),
  });
  return [{ rule: 'PdfaIdentification', action: `Wrote pdfaid:part ${ctx.part}/conformance ${conf} and mirrored /Info into XMP.` }];
};

/** Declare the part's version ceiling in the catalog. This is unconditional:
 *  the serializer emits the catalog /Version as the `%PDF-x.y` header and
 *  defaults to 1.7 without it, so a converted file would otherwise always
 *  breach the part 1 ceiling no matter what the input header said. */
const versionPass: Pass = (ctx) => {
  const ceiling = ctx.part === 1 ? '1.4' : '1.7';
  if (nameOf(ctx, ctx.catalog, 'Version') === ceiling) return [];
  ctx.catalog.set('Version', name(ceiling));
  return [{ rule: 'Version', action: `Set catalog /Version to ${ceiling}.` }];
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
    const fixed = (flags | 4) & ~(1 | 2 | 32); // set Print(4), clear Invisible(1)/Hidden(2)/NoView(32)
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
const PROHIBITED_ACTIONS = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript', 'SetState', 'Hide', 'SetOCGState',
]);

/** True when the named action dict is prohibited. */
function isProhibitedAction(ctx: Cctx, actionObj: PdfObject | undefined): boolean {
  const a = ctx.R(actionObj);
  return isDict(a) && PROHIBITED_ACTIONS.has(nameOf(ctx, a, 'S') ?? '');
}

/** Remove JavaScript and other prohibited actions (and /AA at part 1). */
const actionsPass: Pass = (ctx) => {
  if (ctx.preserve.has('javascript')) return [];
  const actions: ConvertAction[] = [];
  if (isProhibitedAction(ctx, ctx.catalog.get('OpenAction'))) {
    ctx.catalog.delete('OpenAction');
    actions.push({ rule: 'Actions', action: 'Removed prohibited /OpenAction.' });
  }
  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('JavaScript') !== undefined) {
    names.delete('JavaScript');
    actions.push({ rule: 'Actions', action: 'Removed /Names /JavaScript tree.' });
  }
  const stripAA = (dict: PdfDict): void => {
    const aa = ctx.R(dict.get('AA'));
    if (!isDict(aa)) return;
    if (ctx.part === 1) { dict.delete('AA'); actions.push({ rule: 'AdditionalActions', action: 'Removed /AA.' }); return; }
    for (const k of [...aa.keys()]) {
      if (isProhibitedAction(ctx, aa.get(k))) { aa.delete(k); actions.push({ rule: 'AdditionalActions', action: `Removed prohibited /AA /${k}.` }); }
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
    stripAA(dict);
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

/** Remove multimedia annotations. */
const multimediaPass: Pass = (ctx) => {
  if (ctx.preserve.has('multimedia')) return [];
  const actions: ConvertAction[] = [];
  for (const { ref, dict, page } of eachAnnotation(ctx)) {
    const st = nameOf(ctx, dict, 'Subtype');
    if (st && PROHIBITED_ANNOTS.has(st)) {
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

const PASSES: Pass[] = [
  identificationPass, versionPass, fileIdPass, outputIntentPass,
  annotationFlagsPass, formsPass, cosmeticPass,
  actionsPass, multimediaPass, xfaPass, optionalContentPass, embeddedFilesPass, postScriptPass,
  toUnicodePass,
];
