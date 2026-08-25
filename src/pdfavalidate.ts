import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef, isDict, isName, isString, isArray, isStream, isRef,
} from './types.js';
import { ValidationReport, type ValidationIssue, type Severity } from './validation.js';
import { inflateStream } from './flate.js';
import { validatePdfUa } from './structvalidate.js';
import type { Page } from './page.js';
import {
  type Ctx as BaseCtx, memo, nameOf, filterNames, allObjects, xmpText,
  enumerateFonts, descendantFont, hasFontProgram,
  type PageScan, pageScans, usesDeviceColor, extGStates, blendModeName, eachAnnotation,
} from './validatectx.js';

export type { PageScan } from './validatectx.js';
export { memo, filterNames, allObjects, pageScans } from './validatectx.js';

/** Conformance target: part (1/2/3) + level (b/u/a). */
export type PdfALevel = '1b' | '1a' | '2b' | '2u' | '2a' | '3b' | '3u' | '3a';

interface Conformance { part: 1 | 2 | 3; level: 'b' | 'u' | 'a'; }

/** Split a level string into its part number and conformance letter. */
export function parseLevel(level: PdfALevel): Conformance {
  return { part: Number(level[0]) as 1 | 2 | 3, level: level[1] as 'b' | 'u' | 'a' };
}

/** PDF/A run context: the shared scan context plus the conformance target. */
export interface Ctx extends BaseCtx { part: 1 | 2 | 3; level: 'b' | 'u' | 'a'; }

type Rule = (ctx: Ctx) => ValidationIssue[];

/** Entry point. The facade supplies the catalog so catalog-only rules need no
 *  new public accessor (mirrors validatePdfUa). */
export function validatePdfA(doc: Document, catalog: PdfDict, level: PdfALevel): ValidationReport {
  const { part, level: lvl } = parseLevel(level);
  const ctx: Ctx = {
    doc, catalog, part, level: lvl,
    R: (o) => doc.resolve(o),
    cache: new Map(),
  };
  const issues: ValidationIssue[] = [];
  for (const rule of RULES) issues.push(...rule(ctx));
  if (lvl === 'a') {
    for (const ua of validatePdfUa(doc, catalog).Issues) {
      issues.push({ ...ua, rule: `UA:${ua.rule}`, clause: `ISO 19005-${part} §6.8 / ${ua.clause ?? ''}`.trim() });
    }
  }
  return new ValidationReport(issues);
}

// ---- rules -----------------------------------------------------------------

/** PDF/A forbids encryption entirely. */
const encryptionRule: Rule = (ctx) => {
  if (ctx.doc.trailer.get('Encrypt') === undefined) return [];
  return [{
    rule: 'Encryption', severity: 'error', clause: 'ISO 19005-1 §6.1.3',
    message: 'Document is encrypted; PDF/A forbids encryption.',
  }];
};

const fileIdRule: Rule = (ctx) => {
  const id = ctx.doc.trailer.get('ID');
  if (isArray(id) && id.length === 2) return [];
  return [{ rule: 'FileID', severity: 'error', clause: 'ISO 19005-1 §6.1.3',
    message: 'Trailer has no /ID array; PDF/A requires a file identifier.' }];
};

const versionRule: Rule = (ctx) => {
  const ceiling = ctx.part === 1 ? 1.4 : 1.7;
  const over = (v: string | undefined): boolean => v !== undefined && Number(v) > ceiling + 1e-9;
  const header = ctx.doc.headerVersion();
  const cat = nameOf(ctx, ctx.catalog, 'Version');
  if (over(header) || over(cat)) {
    return [{ rule: 'Version', severity: 'error', clause: 'ISO 19005-1 §6.1.2',
      message: `PDF version exceeds the part ${ctx.part} ceiling (${ceiling}).` }];
  }
  return [];
};

const externalStreamRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && obj.dict.get('F') !== undefined
      ? [{ rule: 'ExternalStream', severity: 'error', clause: 'ISO 19005-1 §6.1.7', object,
          message: 'Stream references external file data (/F); PDF/A requires embedded data.' }]
      : []);

const lzwRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && filterNames(obj.dict, ctx.R).includes('LZWDecode')
      ? [{ rule: 'LZW', severity: 'error', clause: 'ISO 19005-1 §6.1.10', object,
          message: 'Stream uses the prohibited /LZWDecode filter.' }]
      : []);

const psXObjectRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) => {
    if (!isStream(obj)) return [];
    const sub = nameOf(ctx, obj.dict, 'Subtype');
    if (sub === 'PS' || obj.dict.get('PS') !== undefined) {
      return [{ rule: 'PostScriptXObject', severity: 'error', clause: 'ISO 19005-1 §6.2.7', object,
        message: 'PostScript XObjects are prohibited in PDF/A.' }];
    }
    return [];
  });

const refXObjectRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Form' && obj.dict.get('Ref') !== undefined
      ? [{ rule: 'ReferenceXObject', severity: 'error', clause: 'ISO 19005-1 §6.2.8', object,
          message: 'Reference XObjects (/Ref) are prohibited in PDF/A.' }]
      : []);

const optionalContentRule: Rule = (ctx) => {
  if (ctx.part !== 1) return [];
  if (ctx.catalog.get('OCProperties') === undefined) return [];
  return [{ rule: 'OptionalContent', severity: 'error', clause: 'ISO 19005-1 §6.1.13',
    message: 'Optional content (/OCProperties) is prohibited in PDF/A-1.' }];
};

/** Read a pdfaid property in attribute or element form. */
function pdfaIdValue(xmp: string, prop: 'part' | 'conformance'): string | undefined {
  const attr = new RegExp(`pdfaid:${prop}\\s*=\\s*["']([^"']+)["']`).exec(xmp);
  if (attr) return attr[1].trim();
  const el = new RegExp(`<pdfaid:${prop}>\\s*([^<]+?)\\s*</pdfaid:${prop}>`).exec(xmp);
  return el ? el[1].trim() : undefined;
}

const metadataRule: Rule = (ctx) => {
  const xmp = xmpText(ctx);
  if (xmp && /<x:xmpmeta|<rdf:RDF/.test(xmp)) return [];
  return [{ rule: 'Metadata', severity: 'error', clause: 'ISO 19005-1 §6.7.2',
    message: 'Document has no well-formed XMP metadata stream (/Root /Metadata).' }];
};

const pdfaIdRule: Rule = (ctx) => {
  const xmp = xmpText(ctx);
  if (!xmp) return []; // metadataRule already reports the absence
  const part = pdfaIdValue(xmp, 'part');
  const conf = pdfaIdValue(xmp, 'conformance');
  const issues: ValidationIssue[] = [];
  if (part !== String(ctx.part)) {
    issues.push({ rule: 'PdfaIdentification', severity: 'error', clause: 'ISO 19005-1 §6.7.11',
      message: `XMP pdfaid:part is '${part ?? '(absent)'}', expected '${ctx.part}'.` });
  }
  if ((conf ?? '').toLowerCase() !== ctx.level) {
    issues.push({ rule: 'PdfaIdentification', severity: 'error', clause: 'ISO 19005-1 §6.7.11',
      message: `XMP pdfaid:conformance is '${conf ?? '(absent)'}', expected '${ctx.level.toUpperCase()}'.` });
  }
  return issues;
};

const xmpInfoConsistencyRule: Rule = (ctx) => {
  const info = ctx.doc.GetMetadata();
  const xmp = ctx.doc.GetXmp();
  const sev: Severity = ctx.part === 1 ? 'error' : 'warning';
  // (field label, Info value, XMP value) — strings only; dates excluded (format-normalization risk).
  const pairs: [string, string | undefined, string | undefined][] = [
    ['title', info.title, xmp.title],
    ['author', info.author, xmp.authors?.join(', ')],
    ['subject', info.subject, xmp.description],
    ['keywords', info.keywords, xmp.keywords],
  ];
  const issues: ValidationIssue[] = [];
  for (const [label, a, b] of pairs) {
    if (a !== undefined && b !== undefined && a !== b) {
      issues.push({ rule: 'XmpInfoConsistency', severity: sev, clause: 'ISO 19005-1 §6.7.3',
        message: `/Info ${label} ('${a}') does not match the XMP value ('${b}').` });
    }
  }
  return issues;
};

const STANDARD_SIMPLE_ENCODINGS = new Set(['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding']);

const fontEmbeddedRule: Rule = (ctx) =>
  enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Type0') {
      const desc = descendantFont(ctx, dict);
      const ok = desc && hasFontProgram(ctx, desc.get('FontDescriptor'));
      return ok ? [] : [{ rule: 'FontEmbedded', severity: 'error', clause: 'ISO 19005-1 §6.3.4', object,
        message: `Type0 font '${nameOf(ctx, dict, 'BaseFont') ?? '?'}' has no embedded descendant font program.` }];
    }
    if (subtype === 'Type3') return []; // Type3 glyphs are content streams; no font program required.
    return hasFontProgram(ctx, dict.get('FontDescriptor'))
      ? []
      : [{ rule: 'FontEmbedded', severity: 'error', clause: 'ISO 19005-1 §6.3.4', object,
          message: `Font '${nameOf(ctx, dict, 'BaseFont') ?? '?'}' is not embedded.` }];
  });

const fontEncodingRule: Rule = (ctx) =>
  enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    if (nameOf(ctx, dict, 'Subtype') !== 'TrueType') return [];
    const fd = ctx.R(dict.get('FontDescriptor'));
    const flags = isDict(fd) ? ctx.R(fd.get('Flags')) : undefined;
    const symbolic = typeof flags === 'number' && (flags & 4) !== 0 && (flags & 32) === 0;
    const encObj = dict.get('Encoding');
    const hasEncoding = encObj !== undefined;
    if (symbolic && hasEncoding) {
      return [{ rule: 'FontEncoding', severity: 'error', clause: 'ISO 19005-1 §6.3.5', object,
        message: 'Symbolic TrueType font must not specify /Encoding.' }];
    }
    if (!symbolic && hasEncoding) {
      const encVal = ctx.R(encObj);
      const base = isName(encVal) ? encVal.name
        : isDict(encVal) ? nameOf(ctx, encVal, 'BaseEncoding') ?? 'WinAnsiEncoding'
        : undefined;
      if (base && !STANDARD_SIMPLE_ENCODINGS.has(base)) {
        return [{ rule: 'FontEncoding', severity: 'error', clause: 'ISO 19005-1 §6.3.5', object,
          message: `Non-symbolic TrueType font uses non-standard encoding '${base}'.` }];
      }
    }
    return [];
  });

const fontCidSetRule: Rule = (ctx) =>
  enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    if (nameOf(ctx, dict, 'Subtype') !== 'Type0') return [];
    const desc = descendantFont(ctx, dict);
    if (!desc) return [];
    const fd = ctx.R(desc.get('FontDescriptor'));
    if (!isDict(fd)) return [];
    // Only subset fonts (BaseFont tag like ABCDEF+Name) must carry /CIDSet.
    const base = nameOf(ctx, desc, 'BaseFont') ?? '';
    const isSubset = /^[A-Z]{6}\+/.test(base);
    if (!isSubset || isStream(ctx.R(fd.get('CIDSet')))) return [];
    return [{ rule: 'FontCIDSet', severity: ctx.part === 1 ? 'error' : 'warning',
      clause: 'ISO 19005-1 §6.3.6', object,
      message: 'Embedded CID subset font has no /CIDSet.' }];
  });

const toUnicodeRule: Rule = (ctx) => {
  if (ctx.level === 'b') return [];
  return enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    if (isStream(ctx.R(dict.get('ToUnicode')))) return [];
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Type0') {
      // Identity CMaps with an Identity ordering are Unicode-recoverable only via ToUnicode.
      return [{ rule: 'ToUnicode', severity: 'error', clause: 'ISO 19005-2 §6.2.11.7.2', object,
        message: 'Type0 font has no /ToUnicode CMap (required for level u/a).' }];
    }
    const encVal = ctx.R(dict.get('Encoding'));
    const base = isName(encVal) ? encVal.name : isDict(encVal) ? nameOf(ctx, encVal, 'BaseEncoding') : undefined;
    if (base && STANDARD_SIMPLE_ENCODINGS.has(base)) return []; // standard encoding ⇒ Unicode-mappable
    return [{ rule: 'ToUnicode', severity: 'error', clause: 'ISO 19005-2 §6.2.11.7.2', object,
      message: 'Simple font has neither /ToUnicode nor a standard predefined encoding (required for level u/a).' }];
  });
};

/** The PDF/A output-intent profile state: a ref, 'missing', or 'multiple' distinct. */
export function pdfaOutputIntentProfile(ctx: Ctx): PdfRef | 'missing' | 'multiple' {
  return memo(ctx, 'oi', () => {
    const ois = ctx.R(ctx.catalog.get('OutputIntents'));
    if (!isArray(ois)) return 'missing';
    const profiles = new Set<number>();
    let firstRef: PdfRef | undefined;
    for (const e of ois) {
      const oi = ctx.R(e);
      if (!isDict(oi)) continue;
      if (nameOf(ctx, oi, 'S') !== 'GTS_PDFA1') continue;
      const dop = oi.get('DestOutputProfile');
      if (isRef(dop)) { profiles.add(dop.num); firstRef = firstRef ?? dop; }
      else if (isStream(ctx.R(dop))) { profiles.add(-1); }
    }
    if (profiles.size === 0) return 'missing';
    if (profiles.size > 1) return 'multiple';
    return firstRef ?? 'missing';
  });
}

const outputIntentRule: Rule = (ctx) => {
  const usesDevice = pageScans(ctx).some(usesDeviceColor);
  if (!usesDevice) return []; // no device-dependent color ⇒ output intent optional
  const state = pdfaOutputIntentProfile(ctx);
  if (state === 'missing') {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 19005-1 §6.2.2',
      message: 'Device-dependent color is used but there is no PDF/A OutputIntent with a /DestOutputProfile.' }];
  }
  if (state === 'multiple') {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 19005-2 §6.2.2',
      message: 'Multiple PDF/A OutputIntents reference different output profiles.' }];
  }
  return [];
};

const iccBasedNRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  // Output-intent profiles.
  const ois = ctx.R(ctx.catalog.get('OutputIntents'));
  if (isArray(ois)) {
    for (const e of ois) {
      const oi = ctx.R(e);
      if (!isDict(oi)) continue;
      const dopRef = oi.get('DestOutputProfile');
      const dop = ctx.R(dopRef);
      if (isStream(dop)) {
        const n = ctx.R(dop.dict.get('N'));
        if (typeof n === 'number' && ![1, 3, 4].includes(n)) {
          issues.push({ rule: 'ICCBasedN', severity: 'error', clause: 'ISO 19005-1 §6.2.2',
            object: isRef(dopRef) ? dopRef : undefined,
            message: `OutputIntent /DestOutputProfile has /N ${n}; must be 1, 3, or 4.` });
        }
      }
    }
  }
  // /ICCBased color-space streams anywhere.
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj)) continue;
    const n = obj.dict.get('N');
    // Heuristic: an ICC profile stream used as a color space carries /N.
    if (typeof ctx.R(n) === 'number' && obj.dict.get('Type') === undefined) {
      const nv = ctx.R(n) as number;
      if (![1, 3, 4].includes(nv)) {
        issues.push({ rule: 'ICCBasedN', severity: 'error', clause: 'ISO 19005-1 §6.2.3.3', object,
          message: `ICC-based color-space stream has /N ${nv}; must be 1, 3, or 4.` });
      }
    }
  }
  return issues;
};

const deviceColorRule: Rule = (ctx) => {
  const state = pdfaOutputIntentProfile(ctx);
  if (state !== 'missing') return []; // an intent covers device color
  return pageScans(ctx).flatMap((s) =>
    usesDeviceColor(s)
      ? [{ rule: 'DeviceColorWithoutIntent', severity: 'error' as const, clause: 'ISO 19005-1 §6.2.3.3', page: s.page,
          message: 'Page uses device-dependent color without a matching PDF/A OutputIntent.' }]
      : []);
};

const STANDARD_BLEND = new Set([
  'Normal', 'Compatible', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion',
  'Hue', 'Saturation', 'Color', 'Luminosity',
]);

const transparencyRule: Rule = (ctx) => {
  if (ctx.part !== 1) return [];
  const issues: ValidationIssue[] = [];
  // Transparency groups on pages and Form XObjects.
  for (const [object, obj] of allObjects(ctx)) {
    const dict = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (!dict) continue;
    const grp = ctx.R(dict.get('Group'));
    if (isDict(grp) && nameOf(ctx, grp, 'S') === 'Transparency') {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 19005-1 §6.4', object,
        message: 'Transparency group is prohibited in PDF/A-1.' });
    }
  }
  // ExtGState soft masks, blend modes, constant alpha.
  for (const { ref: object, dict } of extGStates(ctx)) {
    const sm = ctx.R(dict.get('SMask'));
    if (sm !== undefined && !(isName(sm) && sm.name === 'None')) {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 19005-1 §6.4', object,
        message: 'ExtGState /SMask other than /None is prohibited in PDF/A-1.' });
    }
    const bmName = blendModeName(ctx, dict);
    if (bmName && bmName !== 'Normal' && bmName !== 'Compatible') {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 19005-1 §6.4', object,
        message: `ExtGState blend mode '${bmName}' is prohibited in PDF/A-1.` });
    }
    for (const k of ['CA', 'ca']) {
      const v = ctx.R(dict.get(k));
      if (typeof v === 'number' && v < 1) {
        issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 19005-1 §6.4', object,
          message: `ExtGState /${k} ${v} (< 1) implies transparency, prohibited in PDF/A-1.` });
      }
    }
  }
  return issues;
};

const blendModeRule: Rule = (ctx) => {
  if (ctx.part === 1) return [];
  return extGStates(ctx).flatMap(({ ref: object, dict }) => {
    const bmName = blendModeName(ctx, dict);
    if (bmName && !STANDARD_BLEND.has(bmName)) {
      return [{ rule: 'BlendMode', severity: 'warning', clause: 'ISO 19005-2 §6.2.4.3', object,
        message: `Non-standard blend mode '${bmName}'.` }];
    }
    return [];
  });
};

const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);
const PROHIBITED_ACTIONS = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript', 'SetState', 'Hide', 'SetOCGState',
]);

/** Collect every action /S type reachable from an action dict (following /Next). */
function collectActionTypes(ctx: Ctx, actionObj: PdfObject | undefined, seen = new Set<PdfDict>()): string[] {
  const a = ctx.R(actionObj);
  if (!isDict(a) || seen.has(a)) return [];
  seen.add(a);
  const types: string[] = [];
  const s = nameOf(ctx, a, 'S');
  if (s) types.push(s);
  const next = ctx.R(a.get('Next'));
  if (isArray(next)) for (const n of next) types.push(...collectActionTypes(ctx, n, seen));
  else if (isDict(next)) types.push(...collectActionTypes(ctx, next, seen));
  return types;
}

const annotationAppearanceRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Popup' || subtype === 'Link') return [];
    const ap = ctx.R(dict.get('AP'));
    const n = isDict(ap) ? ap.get('N') : undefined;
    if (n === undefined) {
      return [{ rule: 'AnnotationAppearance', severity: 'error', clause: 'ISO 19005-1 §6.5.3', object, page,
        message: `${subtype ?? 'Annotation'} has no normal appearance stream (/AP /N).` }];
    }
    return [];
  });

const annotationSubtypeRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    return subtype && PROHIBITED_ANNOTS.has(subtype)
      ? [{ rule: 'AnnotationSubtype', severity: 'error', clause: 'ISO 19005-1 §6.5.2', object, page,
          message: `Annotation subtype /${subtype} is prohibited in PDF/A.` }]
      : [];
  });

const annotationFlagsRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Popup') return [];
    const f = ctx.R(dict.get('F'));
    const flags = typeof f === 'number' ? f : 0;
    const mk = (which: string): ValidationIssue => ({
      rule: 'AnnotationFlags', severity: 'error', clause: 'ISO 19005-1 §6.5.3', object, page,
      message: `Annotation flag invalid for PDF/A (${which}).`,
    });
    const issues: ValidationIssue[] = [];
    if ((flags & 2) !== 0) issues.push(mk('Hidden'));       // bit 2
    if ((flags & 32) !== 0) issues.push(mk('NoView'));      // bit 6
    if ((flags & 1) !== 0) issues.push(mk('Invisible'));    // bit 1
    if ((flags & 4) === 0) issues.push(mk('not Print'));    // bit 3 must be set
    return issues;
  });

const annotationOpacityRule: Rule = (ctx) => {
  if (ctx.part !== 1) return [];
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const ca = ctx.R(dict.get('CA'));
    return typeof ca === 'number' && ca !== 1
      ? [{ rule: 'AnnotationOpacity', severity: 'error', clause: 'ISO 19005-1 §6.5.3', object, page,
          message: `Annotation /CA ${ca} (≠ 1) is prohibited in PDF/A-1.` }]
      : [];
  });
};

const actionsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const check = (obj: PdfObject | undefined, where: string): void => {
    for (const t of collectActionTypes(ctx, obj)) {
      if (PROHIBITED_ACTIONS.has(t)) {
        issues.push({ rule: 'Actions', severity: 'error', clause: 'ISO 19005-1 §6.6.1',
          message: `Prohibited action /${t} (${where}).` });
      }
    }
  };
  check(ctx.catalog.get('OpenAction'), 'catalog /OpenAction');
  // /Names /JavaScript tree ⇒ JavaScript actions present.
  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('JavaScript') !== undefined) {
    issues.push({ rule: 'Actions', severity: 'error', clause: 'ISO 19005-1 §6.6.1',
      message: 'Document contains a /Names /JavaScript tree (JavaScript actions).' });
  }
  for (const { dict } of eachAnnotation(ctx)) check(dict.get('A'), 'annotation /A');
  return issues;
};

const additionalActionsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const slots: [PdfObject | undefined, string][] = [
    [ctx.catalog.get('AA'), 'catalog /AA'],
    ...ctx.doc.Pages.map((p) => [p.Dict.get('AA'), 'page /AA'] as [PdfObject | undefined, string]),
    ...eachAnnotation(ctx).map(({ dict }) => [dict.get('AA'), 'annotation /AA'] as [PdfObject | undefined, string]),
  ];
  for (const [aa, where] of slots) {
    const d = ctx.R(aa);
    if (!isDict(d)) continue;
    if (ctx.part === 1) {
      issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-1 §6.6.2',
        message: `Additional-actions dictionary (${where}) is prohibited in PDF/A-1.` });
    } else {
      for (const v of d.values()) {
        for (const t of collectActionTypes(ctx, v)) {
          if (PROHIBITED_ACTIONS.has(t)) {
            issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-2 §6.6.2',
              message: `Prohibited action /${t} in additional-actions (${where}).` });
          }
        }
      }
    }
  }
  return issues;
};

const needAppearancesRule: Rule = (ctx) => {
  const acro = ctx.R(ctx.catalog.get('AcroForm'));
  if (isDict(acro) && ctx.R(acro.get('NeedAppearances')) === true) {
    return [{ rule: 'NeedAppearances', severity: 'error', clause: 'ISO 19005-1 §6.9',
      message: 'AcroForm /NeedAppearances is true; PDF/A requires generated appearances.' }];
  }
  return [];
};

const xfaRule: Rule = (ctx) => {
  const acro = ctx.R(ctx.catalog.get('AcroForm'));
  if (isDict(acro) && acro.get('XFA') !== undefined) {
    return [{ rule: 'XFA', severity: 'error', clause: 'ISO 19005-2 §6.9',
      message: 'Dynamic XFA forms (/AcroForm /XFA) are prohibited in PDF/A.' }];
  }
  return [];
};

const STANDARD_INTENTS = new Set(['AbsoluteColorimetric', 'RelativeColorimetric', 'Saturation', 'Perceptual']);

const imageFilterRule: Rule = (ctx) => {
  const prohibited = new Set(['LZWDecode', ...(ctx.part === 1 ? ['JPXDecode', 'JBIG2Decode'] : [])]);
  const issues: ValidationIssue[] = [];
  // Image XObjects.
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj) || nameOf(ctx, obj.dict, 'Subtype') !== 'Image') continue;
    for (const f of filterNames(obj.dict, ctx.R)) {
      if (prohibited.has(f)) {
        issues.push({ rule: 'ImageFilter', severity: 'error', clause: 'ISO 19005-1 §6.2.5', object,
          message: `Image uses the prohibited filter /${f}.` });
      }
    }
  }
  // Inline images (from the content scan).
  for (const s of pageScans(ctx)) {
    for (const f of s.inlineImageFilters) {
      if (prohibited.has(f)) {
        issues.push({ rule: 'ImageFilter', severity: 'error', clause: 'ISO 19005-1 §6.2.5', page: s.page,
          message: `Inline image uses the prohibited filter /${f}.` });
      }
    }
  }
  return issues;
};

const imageInterpolateRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Image' && ctx.R(obj.dict.get('Interpolate')) === true
      ? [{ rule: 'ImageInterpolate', severity: 'warning', clause: 'ISO 19005-1 §6.2.6', object,
          message: 'Image /Interpolate true is prohibited in PDF/A.' }]
      : []);

const renderingIntentRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  // From content `ri` operators.
  for (const s of pageScans(ctx)) {
    for (const ri of s.renderingIntents) {
      if (!STANDARD_INTENTS.has(ri)) {
        issues.push({ rule: 'RenderingIntent', severity: 'error', clause: 'ISO 19005-1 §6.2.9', page: s.page,
          message: `Non-standard rendering intent '${ri}'.` });
      }
    }
  }
  // From image-XObject /Intent.
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj) || nameOf(ctx, obj.dict, 'Subtype') !== 'Image') continue;
    const intent = nameOf(ctx, obj.dict, 'Intent');
    if (intent && !STANDARD_INTENTS.has(intent)) {
      issues.push({ rule: 'RenderingIntent', severity: 'error', clause: 'ISO 19005-1 §6.2.9', object,
        message: `Image uses non-standard rendering intent '${intent}'.` });
    }
  }
  return issues;
};

const RULES: Rule[] = [
  encryptionRule, fileIdRule, versionRule, externalStreamRule, lzwRule,
  psXObjectRule, refXObjectRule, optionalContentRule,
  metadataRule, pdfaIdRule, xmpInfoConsistencyRule,
  fontEmbeddedRule, fontEncodingRule, fontCidSetRule, toUnicodeRule,
  outputIntentRule, iccBasedNRule, deviceColorRule,
  transparencyRule, blendModeRule,
  annotationAppearanceRule, annotationSubtypeRule, annotationFlagsRule, annotationOpacityRule,
  actionsRule, additionalActionsRule, needAppearancesRule, xfaRule,
  imageFilterRule, imageInterpolateRule, renderingIntentRule,
];
