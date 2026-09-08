import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef, isDict, isName, isString, isArray, isStream, isRef,
} from './types.js';
import { ValidationReport, type ValidationIssue, type Severity } from './validation.js';
import { inflateStream } from './flate.js';
import { validatePdfUa } from './structvalidate.js';
import { parseCMap } from './cmap.js';
import type { Page } from './page.js';
import {
  type Ctx as BaseCtx, memo, nameOf, filterNames, allObjects, xmpText,
  enumerateFonts, descendantFont, hasFontProgram,
  type PageScan, pageScans, usesDeviceColor, extGStates, blendModeName, eachAnnotation,
} from './validatectx.js';

export type { PageScan } from './validatectx.js';
export { memo, filterNames, allObjects, pageScans } from './validatectx.js';

/** Conformance target: part (1/2/3/4) + level. Parts 1–3 take b/u/a; PDF/A-4
 *  takes '' (the base conformance), 'e' (engineering) or 'f' (embedded files).
 *
 *  Note there is no '4a'. ISO 19005-4 has no clause 6.8 and no accessibility
 *  level — tagging is declared through PDF/UA instead — so the level is
 *  *unrepresentable* rather than merely unsupported, and validatePdfA's
 *  `lvl === 'a'` PDF/UA chain provably cannot fire for part 4. */
export type PdfALevel = '1b' | '1a' | '2b' | '2u' | '2a' | '3b' | '3u' | '3a'
  | '4' | '4e' | '4f';

interface Conformance { part: 1 | 2 | 3 | 4; level: 'b' | 'u' | 'a' | '' | 'e' | 'f'; }

/** Split a level string into its part number and conformance letter. PDF/A-4's
 *  base level is the bare '4', which has no second character. */
export function parseLevel(level: PdfALevel): Conformance {
  return {
    part: Number(level[0]) as 1 | 2 | 3 | 4,
    level: (level[1] ?? '') as Conformance['level'],
  };
}

/** PDF/A run context: the shared scan context plus the conformance target. */
export interface Ctx extends BaseCtx {
  part: 1 | 2 | 3 | 4;
  level: 'b' | 'u' | 'a' | '' | 'e' | 'f';
}

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

/** The clause number a check carries in each standard. Key `2` serves parts 2
 *  AND 3, which share numbering; part 4 renumbered nearly everything. */
export type PartClauses = { 1?: string; 2?: string; 4?: string };

/** The ISO clause to cite for this target. Each rule states its own numbers,
 *  because the SAME test is numbered differently per standard — the image keys
 *  are 6.2.4 in 19005-1, 6.2.8 in -2/-3 and 6.2.7.1 in -4. A backport that
 *  keeps citing -4 reports the right defect against the wrong document. */
export function partClause(part: 1 | 2 | 3 | 4, cl: PartClauses): string {
  const n = part === 1 ? cl[1] : part === 4 ? cl[4] : cl[2];
  return `ISO 19005-${part} §${n}`;
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
  const header = ctx.doc.headerVersion();
  const cat = nameOf(ctx, ctx.catalog, 'Version');
  if (ctx.part === 4) {
    // ISO 19005-4 6.1.2-1 / 6.1.12-1: not a ceiling but an exact major — both
    // the header and a stated catalog /Version must read 2.n, so a perfectly
    // good PDF 1.7 file is simply not PDF/A-4.
    const bad = (v: string | undefined): boolean => v !== undefined && !/^2\.\d+$/.test(v);
    if (bad(header) || bad(cat)) {
      return [{ rule: 'Version', severity: 'error', clause: 'ISO 19005-4 §6.1.2',
        message: `PDF/A-4 requires PDF 2.n; found header '${header ?? '(absent)'}'${cat ? `, catalog /Version '${cat}'` : ''}.` }];
    }
    if (header === undefined) {
      return [{ rule: 'Version', severity: 'error', clause: 'ISO 19005-4 §6.1.2',
        message: 'PDF/A-4 requires a PDF 2.n header; none was found.' }];
    }
    return [];
  }
  const ceiling = ctx.part === 1 ? 1.4 : 1.7;
  const over = (v: string | undefined): boolean => v !== undefined && Number(v) > ceiling + 1e-9;
  if (over(header) || over(cat)) {
    return [{ rule: 'Version', severity: 'error', clause: 'ISO 19005-1 §6.1.2',
      message: `PDF version exceeds the part ${ctx.part} ceiling (${ceiling}).` }];
  }
  return [];
};

const externalStreamRule: Rule = (ctx) => {
  // ISO 19005-4 6.1.6.1-2 bans /FFilter and /FDecodeParms alongside /F.
  const keys = ctx.part === 4 ? ['F', 'FFilter', 'FDecodeParms'] : ['F'];
  return allObjects(ctx).flatMap(([object, obj]) => {
    if (!isStream(obj)) return [];
    const hit = keys.find((k) => obj.dict.get(k) !== undefined);
    return hit === undefined ? [] : [{
      rule: 'ExternalStream', severity: 'error' as const,
      clause: ctx.part === 4 ? 'ISO 19005-4 §6.1.6.1' : 'ISO 19005-1 §6.1.7', object,
      message: `Stream references external file data (/${hit}); PDF/A requires embedded data.`,
    }];
  });
};

const lzwRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && filterNames(obj.dict, ctx.R).includes('LZWDecode')
      ? [{ rule: 'LZW', severity: 'error', clause: 'ISO 19005-1 §6.1.10', object,
          message: 'Stream uses the prohibited /LZWDecode filter.' }]
      : []);

/** Note, a deliberate divergence from the anchor: the veraPDF PDF/A-4 profile
 *  has NO PostScript-XObject rule, because PDF 2.0 removed the construct
 *  outright. This keeps firing at part 4 — it can only match something PDF 2.0
 *  does not define, so a hit is a real defect the profile happens not to
 *  enumerate. Recorded so it reads as a decision rather than an oversight. */
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
function pdfaIdValue(xmp: string, prop: 'part' | 'conformance' | 'rev'): string | undefined {
  // `*` rather than `+` (ugxr): an EMPTY attribute is a present property with
  // an invalid value, not a missing one. ISO 19005-4 6.7.3-3 spells the base
  // conformance by genuine ABSENCE, so with `+` a file declaring
  // pdfaid:conformance="" read as conformant and passed.
  const attr = new RegExp(`pdfaid:${prop}\\s*=\\s*["']([^"']*)["']`).exec(xmp);
  if (attr) return attr[1].trim();
  const el = new RegExp(`<pdfaid:${prop}>\\s*([^<]*?)\\s*</pdfaid:${prop}>`).exec(xmp);
  return el ? el[1].trim() : undefined;
}

const metadataRule: Rule = (ctx) => {
  const xmp = xmpText(ctx);
  if (xmp && /<x:xmpmeta|<rdf:RDF/.test(xmp)) return [];
  return [{ rule: 'Metadata', severity: 'error', clause: 'ISO 19005-1 §6.7.2',
    message: 'Document has no well-formed XMP metadata stream (/Root /Metadata).' }];
};

/** The pdfaid:conformance a target requires: undefined means it must be ABSENT
 *  (PDF/A-4's base conformance), otherwise the expected upper-case letter. */
function expectedConformance(ctx: Ctx): string | undefined {
  if (ctx.part !== 4) return ctx.level.toUpperCase();
  return ctx.level === '' ? undefined : ctx.level.toUpperCase();
}

const pdfaIdRule: Rule = (ctx) => {
  const xmp = xmpText(ctx);
  if (!xmp) return []; // metadataRule already reports the absence
  const part = pdfaIdValue(xmp, 'part');
  const conf = pdfaIdValue(xmp, 'conformance');
  const clause = ctx.part === 4 ? 'ISO 19005-4 §6.7.3' : 'ISO 19005-1 §6.7.11';
  const issues: ValidationIssue[] = [];
  const mk = (message: string): void => {
    issues.push({ rule: 'PdfaIdentification', severity: 'error', clause, message });
  };
  if (part !== String(ctx.part)) {
    mk(`XMP pdfaid:part is '${part ?? '(absent)'}', expected '${ctx.part}'.`);
  }
  const want = expectedConformance(ctx);
  if (want === undefined) {
    // ISO 19005-4 6.7.3-3: the base conformance is spelled by ABSENCE.
    if (conf !== undefined) {
      mk(`XMP pdfaid:conformance is '${conf}', but PDF/A-4 requires it to be absent.`);
    }
  } else if ((conf ?? '').toLowerCase() !== want.toLowerCase()) {
    mk(`XMP pdfaid:conformance is '${conf ?? '(absent)'}', expected '${want}'.`);
  }
  if (ctx.part === 4) {
    // ISO 19005-4 6.7.3-5. Parts 1–3 have no rev property at all.
    const rev = pdfaIdValue(xmp, 'rev');
    if (rev !== '2020') mk(`XMP pdfaid:rev is '${rev ?? '(absent)'}', expected '2020'.`);
  }
  return issues;
};

const xmpInfoConsistencyRule: Rule = (ctx) => {
  // Superseded at part 4 by infoRestrictionRule: PDF/A-4 permits /Info only
  // alongside a catalog /PieceInfo, and then only /ModDate — so there is no
  // title or author left to disagree with XMP about.
  if (ctx.part === 4) return [];
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

const fontCidSetRule: Rule = (ctx) => {
  // ISO 19005-4 has no /CIDSet or /CharSet rule at all; PDF 2.0 deprecated both.
  if (ctx.part === 4) return [];
  return enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
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
};

const toUnicodeRule: Rule = (ctx) => {
  // ISO 19005-4 has NO /ToUnicode presence requirement — clause 6.2.10.7
  // constrains a ToUnicode CMap's contents only if one exists (see
  // toUnicodeContentRule). This contradicts the widespread 'PDF/A-4 ≈
  // PDF/A-2u' folklore; the veraPDF profile is the anchor and has no such rule.
  if (ctx.part === 4 || ctx.level === 'b') return [];
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
    // Presence is tested on the RAW dict: ctx.R(undefined) returns null, and
    // `null !== undefined` is true, so resolving first reported a soft mask for
    // every ExtGState that has none. Never fired before pjy7 because no part-1
    // fixture carried an ExtGState at all.
    const sm = dict.get('SMask') === undefined ? undefined : ctx.R(dict.get('SMask'));
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
      // 6.2.9-1 is a *shall* clause in ISO 19005-4; parts 2/3 keep the warning.
      return [{ rule: 'BlendMode', severity: ctx.part === 4 ? 'error' as const : 'warning' as const,
        clause: ctx.part === 4 ? 'ISO 19005-4 §6.2.9' : 'ISO 19005-2 §6.2.4.3', object,
        message: `Non-standard blend mode '${bmName}'.` }];
    }
    return [];
  });
};

const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);

/** ISO 19005-4 6.3.1-1: FileAttachment joins the prohibited set. 3D and
 *  RichMedia come back off it at 4e — that allowance is most of what makes
 *  PDF/A-4e the engineering conformance. */
const PROHIBITED_ANNOTS_A4 = new Set([
  'Movie', 'Sound', 'Screen', '3D', 'RichMedia', 'FileAttachment',
]);

function prohibitedAnnots(ctx: Ctx): Set<string> {
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

/** ISO 19005-4 6.6.1-1. Note what is ABSENT: JavaScript is permitted in
 *  PDF/A-4, where parts 1–3 prohibit it. 'Rendition' and 'Trans' are new. */
const PROHIBITED_ACTIONS_A4 = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide',
  'Rendition', 'Trans', 'SetOCGState', 'GoTo3DView', 'SetState', 'NoOp',
]);

/** ISO 19005-4 6.6.1-2: named actions are limited to page navigation. */
const PERMITTED_NAMED_ACTIONS = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);

/** The prohibited-action set for the target. PDF/A-4e re-permits SetOCGState
 *  and GoTo3DView, which is most of what makes it the engineering level. */
function prohibitedActions(ctx: Ctx): Set<string> {
  if (ctx.part !== 4) return PROHIBITED_ACTIONS;
  if (ctx.level !== 'e') return PROHIBITED_ACTIONS_A4;
  const s = new Set(PROHIBITED_ACTIONS_A4);
  s.delete('SetOCGState');
  s.delete('GoTo3DView');
  return s;
}

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

/** Every /N value of a /Named action reachable from the catalog or an
 *  annotation, for ISO 19005-4 6.6.1-2. */
function collectNamedActions(ctx: Ctx): string[] {
  const out: string[] = [];
  const walk = (obj: PdfObject | undefined, seen = new Set<PdfDict>()): void => {
    const a = ctx.R(obj);
    if (!isDict(a) || seen.has(a)) return;
    seen.add(a);
    if (nameOf(ctx, a, 'S') === 'Named') {
      const n = nameOf(ctx, a, 'N');
      if (n) out.push(n);
    }
    const next = ctx.R(a.get('Next'));
    if (isArray(next)) for (const n of next) walk(n, seen);
    else if (isDict(next)) walk(next, seen);
  };
  walk(ctx.catalog.get('OpenAction'));
  for (const { dict } of eachAnnotation(ctx)) walk(dict.get('A'));
  return out;
}

const annotationAppearanceRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Popup' || subtype === 'Link') return [];
    // ISO 19005-4 6.3.3-1 adds /Projection to the exempt list.
    if (ctx.part === 4 && subtype === 'Projection') return [];
    const ap = ctx.R(dict.get('AP'));
    const n = isDict(ap) ? ap.get('N') : undefined;
    if (n === undefined) {
      return [{ rule: 'AnnotationAppearance', severity: 'error' as const,
        clause: ctx.part === 4 ? 'ISO 19005-4 §6.3.3' : 'ISO 19005-1 §6.5.3', object, page,
        message: `${subtype ?? 'Annotation'} has no normal appearance stream (/AP /N).` }];
    }
    return [];
  });

const annotationSubtypeRule: Rule = (ctx) => {
  const banned = prohibitedAnnots(ctx);
  const clause = ctx.part === 4 ? 'ISO 19005-4 §6.3.1' : 'ISO 19005-1 §6.5.2';
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    return subtype && banned.has(subtype)
      ? [{ rule: 'AnnotationSubtype', severity: 'error' as const, clause, object, page,
          message: `Annotation subtype /${subtype} is prohibited in PDF/A.` }]
      : [];
  });
};

const annotationFlagsRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Popup') return [];
    const f = ctx.R(dict.get('F'));
    const flags = typeof f === 'number' ? f : 0;
    const clause = ctx.part === 4 ? 'ISO 19005-4 §6.3.2' : 'ISO 19005-1 §6.5.3';
    const mk = (which: string): ValidationIssue => ({
      rule: 'AnnotationFlags', severity: 'error', clause, object, page,
      message: `Annotation flag invalid for PDF/A (${which}).`,
    });
    const issues: ValidationIssue[] = [];
    if ((flags & 2) !== 0) issues.push(mk('Hidden'));       // bit 2
    if ((flags & 32) !== 0) issues.push(mk('NoView'));      // bit 6
    if ((flags & 1) !== 0) issues.push(mk('Invisible'));    // bit 1
    if ((flags & 4) === 0) issues.push(mk('not Print'));    // bit 3 must be set
    // ISO 19005-4 6.3.2-2 adds ToggleNoView (bit 9).
    if (ctx.part === 4 && (flags & 256) !== 0) issues.push(mk('ToggleNoView'));
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
  const banned = prohibitedActions(ctx);
  const clause = ctx.part === 4 ? 'ISO 19005-4 §6.6.1' : 'ISO 19005-1 §6.6.1';
  const issues: ValidationIssue[] = [];
  const check = (obj: PdfObject | undefined, where: string): void => {
    for (const t of collectActionTypes(ctx, obj)) {
      if (banned.has(t)) {
        issues.push({ rule: 'Actions', severity: 'error', clause,
          message: `Prohibited action /${t} (${where}).` });
      }
    }
  };
  check(ctx.catalog.get('OpenAction'), 'catalog /OpenAction');
  // A /Names /JavaScript tree implies JavaScript actions — prohibited at parts
  // 1–3 and permitted at part 4, so this check is part-gated with the set above.
  if (banned.has('JavaScript')) {
    const names = ctx.R(ctx.catalog.get('Names'));
    if (isDict(names) && names.get('JavaScript') !== undefined) {
      issues.push({ rule: 'Actions', severity: 'error', clause,
        message: 'Document contains a /Names /JavaScript tree (JavaScript actions).' });
    }
  }
  for (const { dict } of eachAnnotation(ctx)) check(dict.get('A'), 'annotation /A');
  if (ctx.part === 4) {
    for (const named of collectNamedActions(ctx)) {
      if (!PERMITTED_NAMED_ACTIONS.has(named)) {
        issues.push({ rule: 'Actions', severity: 'error', clause: 'ISO 19005-4 §6.6.1',
          message: `Named action /${named} is not one of NextPage, PrevPage, FirstPage, LastPage.` });
      }
    }
  }
  return issues;
};

/** ISO 19005-4 6.6.3-1: the permitted additional-action triggers. */
const PERMITTED_AA_KEYS = new Set(['E', 'X', 'D', 'U', 'Fo', 'Bl']);

const additionalActionsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const slots: [PdfObject | undefined, string, string | undefined][] = [
    [ctx.catalog.get('AA'), 'catalog /AA', undefined],
    ...ctx.doc.Pages.map((p) =>
      [p.Dict.get('AA'), 'page /AA', undefined] as [PdfObject | undefined, string, string | undefined]),
    ...eachAnnotation(ctx).map(({ dict }) =>
      [dict.get('AA'), 'annotation /AA', nameOf(ctx, dict, 'Subtype')] as [PdfObject | undefined, string, string | undefined]),
  ];
  for (const [aa, where, subtype] of slots) {
    const d = ctx.R(aa);
    if (!isDict(d)) continue;
    if (ctx.part === 1) {
      issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-1 §6.6.2',
        message: `Additional-actions dictionary (${where}) is prohibited in PDF/A-1.` });
      continue;
    }
    if (ctx.part === 4) {
      // 6.6.3-1 exempts Widget annotations, whose triggers are the form's.
      if (subtype === 'Widget') continue;
      for (const k of d.keys()) {
        if (!PERMITTED_AA_KEYS.has(k)) {
          issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-4 §6.6.3',
            message: `Additional-actions key /${k} (${where}) is not one of E, X, D, U, Fo, Bl.` });
        }
      }
      continue;
    }
    for (const v of d.values()) {
      for (const t of collectActionTypes(ctx, v)) {
        if (PROHIBITED_ACTIONS.has(t)) {
          issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-2 §6.6.2',
            message: `Prohibited action /${t} in additional-actions (${where}).` });
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

const imageInterpolateRule: Rule = (ctx) => {
  // 6.2.7.1-3 is a *shall* clause in ISO 19005-4; parts 1–3 keep the warning.
  const severity: Severity = ctx.part === 4 ? 'error' : 'warning';
  const clause = ctx.part === 4 ? 'ISO 19005-4 §6.2.7.1' : 'ISO 19005-1 §6.2.6';
  return allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Image' && ctx.R(obj.dict.get('Interpolate')) === true
      ? [{ rule: 'ImageInterpolate', severity, clause, object,
          message: 'Image /Interpolate true is prohibited in PDF/A.' }]
      : []);
};

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

// ---- PDF/A-4 ToUnicode contents, appearances, optional content -------------

/** ISO 19005-4 6.2.10.7-1. Note the direction: PDF/A-4 has NO /ToUnicode
 *  presence requirement (see toUnicodeRule) — this constrains the contents of
 *  a CMap that does exist. */
const toUnicodeContentRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  for (const { ref: object, dict } of enumerateFonts(ctx)) {
    const tu = ctx.R(dict.get('ToUnicode'));
    if (!isStream(tu)) continue;
    let entries: [number, string][];
    try {
      entries = parseCMap(inflateStream(tu)).entries();
    } catch {
      continue; // an unreadable CMap is not this rule's finding
    }
    for (const [code, value] of entries) {
      for (const ch of value) {
        const cp = ch.codePointAt(0);
        if (cp === 0x0000 || cp === 0xFEFF || cp === 0xFFFE) {
          issues.push({ rule: 'ToUnicodeContent', severity: 'error', clause: 'ISO 19005-4 §6.2.10.7', object,
            message: `ToUnicode CMap maps code ${code} to U+${cp.toString(16).toUpperCase().padStart(4, '0')}, which is prohibited.` });
          break;
        }
      }
    }
  }
  return issues;
};

/** ISO 19005-1 6.5.3-4, -2/-3 6.3.3-2, -4 6.3.3-1: an appearance dictionary
 *  may hold only /N. */
const appearanceKeysRule: Rule = (ctx) => {
  const clause = partClause(ctx.part, { 1: '6.5.3', 2: '6.3.3', 4: '6.3.3' });
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const ap = ctx.R(dict.get('AP'));
    if (!isDict(ap)) return [];
    return [...ap.keys()].filter((k) => k !== 'N').map((k) => ({
      rule: 'AppearanceKeys', severity: 'error' as const, clause, object, page,
      message: `Appearance dictionary contains /${k}; PDF/A-${ctx.part} permits only /N.`,
    }));
  });
};

/** The Widget action keys the target prohibits.
 *
 *  Invariant, and it reads backwards: parts 1-3 are STRICTER than part 4 here.
 *  ISO 19005-1 6.6.1-3 (/A) and 6.6.2-1 (/AA), and -2/-3 6.4.1-1, ban both;
 *  ISO 19005-4 6.4.1-1 bans /A alone, and 6.6.3-1 explicitly EXEMPTS a Widget's
 *  additional actions, "whose triggers are the form's". Widening part 4 to
 *  match the older parts would report a document the newest standard permits. */
export function widgetActionKeys(part: 1 | 2 | 3 | 4): string[] {
  return part === 4 ? ['A'] : ['A', 'AA'];
}

const widgetActionRule: Rule = (ctx) => {
  const clause = partClause(ctx.part, { 1: '6.6.1', 2: '6.4.1', 4: '6.4.1' });
  const keys = widgetActionKeys(ctx.part);
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    if (nameOf(ctx, dict, 'Subtype') !== 'Widget') return [];
    return keys.filter((k) => dict.get(k) !== undefined).map((k) => ({
      rule: 'WidgetAction', severity: 'error' as const, clause, object, page,
      message: `Widget annotation carries /${k}; prohibited in PDF/A-${ctx.part}.`,
    }));
  });
};

/** ISO 19005-4 6.10-1/-2. veraPDF's third test — /Order naming every OCG
 *  (6.10-3) — is deliberately NOT implemented: it needs a full walk of the OCG
 *  set against a nested order array, for a check no caller has asked for. */
const ocConfigRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const ocp = ctx.R(ctx.catalog.get('OCProperties'));
  if (!isDict(ocp)) return [];
  const configs: PdfDict[] = [];
  const d = ctx.R(ocp.get('D'));
  if (isDict(d)) configs.push(d);
  const alt = ctx.R(ocp.get('Configs'));
  if (isArray(alt)) for (const c of alt) { const cd = ctx.R(c); if (isDict(cd)) configs.push(cd); }
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const cfg of configs) {
    const nm = ctx.R(cfg.get('Name'));
    if (!isString(nm)) {
      issues.push({ rule: 'OcConfig', severity: 'error', clause: 'ISO 19005-4 §6.10',
        message: 'Optional-content configuration has no /Name.' });
      continue;
    }
    const key = new TextDecoder('latin1').decode(nm.bytes);
    if (seen.has(key)) {
      issues.push({ rule: 'OcConfig', severity: 'error', clause: 'ISO 19005-4 §6.10',
        message: `Optional-content configuration name '${key}' is not unique.` });
    }
    seen.add(key);
  }
  return issues;
};

// ---- PDF/A-4 graphics ------------------------------------------------------

/** ISO 19005-1 6.2.8-1/-2, -2/-3 6.2.5-1/-2, -4 6.2.5-1/-2/-3. /TR and /TR2 are
 *  policed at EVERY part; /HTO is a PDF 2.0 key and appears in the part-4
 *  profile alone, so it stays gated. */
const extGStateKeysRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const clause = partClause(ctx.part, { 1: '6.2.8', 2: '6.2.5', 4: '6.2.5' });
  // Transfer and halftone-origin functions are prohibited outright.
  const prohibited = ctx.part === 4 ? ['TR', 'HTO'] : ['TR'];
  for (const { ref: object, dict } of extGStates(ctx)) {
    for (const k of prohibited) {
      if (dict.get(k) !== undefined) {
        issues.push({ rule: 'ExtGStateKeys', severity: 'error', clause, object,
          message: `ExtGState /${k} is prohibited in PDF/A-${ctx.part}.` });
      }
    }
    // /TR2 survives, but only as /Default.
    if (dict.get('TR2') !== undefined && nameOf(ctx, dict, 'TR2') !== 'Default') {
      issues.push({ rule: 'ExtGStateKeys', severity: 'error', clause, object,
        message: `ExtGState /TR2 must be /Default in PDF/A-${ctx.part}.` });
    }
  }
  return issues;
};

/** ISO 19005-2/-3 6.2.5-4/-5 and -4 6.2.5-4/-5. Absent from the part-1
 *  profile, so it stays silent there. A type outside {1,5} is reported and
 *  never repaired: forcing it to 1 would change how the page prints. */
const halftoneRule: Rule = (ctx) => {
  if (ctx.part === 1) return [];
  const issues: ValidationIssue[] = [];
  const clause = partClause(ctx.part, { 2: '6.2.5', 4: '6.2.5' });
  for (const { ref: object, dict } of extGStates(ctx)) {
    const ht = ctx.R(dict.get('HT'));
    if (!isDict(ht)) continue;
    const type = ctx.R(ht.get('HalftoneType'));
    if (typeof type === 'number' && type !== 1 && type !== 5) {
      issues.push({ rule: 'Halftone', severity: 'error', clause, object,
        message: `Halftone type ${type} is prohibited in PDF/A-${ctx.part}; only 1 and 5 are permitted.` });
    }
    if (ht.get('HalftoneName') !== undefined) {
      issues.push({ rule: 'Halftone', severity: 'error', clause, object,
        message: `Halftone /HalftoneName is prohibited in PDF/A-${ctx.part}.` });
    }
  }
  return issues;
};

const PERMITTED_BPC = new Set([1, 2, 4, 8, 16]);
/** ISO 19005-1 6.2.4-4 stops at 8 where -2/-3/-4 admit 16: PDF 1.4 had no
 *  16-bit images. So a 16-bit image is legal at parts 2/3/4 and illegal at
 *  part 1 — the one check in this validator that can fail a document at an
 *  EARLIER part than it passes at a later one. */
const PERMITTED_BPC_A1 = new Set([1, 2, 4, 8]);

export function permittedBpc(part: 1 | 2 | 3 | 4): Set<number> {
  return part === 1 ? PERMITTED_BPC_A1 : PERMITTED_BPC;
}

/** ISO 19005-1 6.2.4-1/-2/-4/-5, -2/-3 6.2.8-1/-2/-4/-5, -4 6.2.7.1-1/-4/-5. */
const imageKeysRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const clause = partClause(ctx.part, { 1: '6.2.4', 2: '6.2.8', 4: '6.2.7.1' });
  const permitted = permittedBpc(ctx.part);
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj) || nameOf(ctx, obj.dict, 'Subtype') !== 'Image') continue;
    for (const k of ['Alternates', 'OPI']) {
      if (obj.dict.get(k) !== undefined) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause, object,
          message: `Image /${k} is prohibited in PDF/A-${ctx.part}.` });
      }
    }
    const bpc = ctx.R(obj.dict.get('BitsPerComponent'));
    const isMask = ctx.R(obj.dict.get('ImageMask')) === true;
    if (typeof bpc === 'number') {
      if (isMask && bpc !== 1) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause, object,
          message: `Image mask /BitsPerComponent is ${bpc}; must be 1.` });
      } else if (!isMask && !permitted.has(bpc)) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause, object,
          message: `Image /BitsPerComponent is ${bpc}; must be ${[...permitted].join(', ')}.` });
      }
    }
  }
  return issues;
};

/** ISO 19005-1 6.2.4-2 (object PDXObject, so forms as well as images),
 *  -2/-3 6.2.9-1 (PDXForm, bundled with the PostScript test) and -4 6.2.8.1-1.
 *  Three clause numbers, one test. */
const formXObjectOpiRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Form' && obj.dict.get('OPI') !== undefined
      ? [{ rule: 'FormXObjectOpi', severity: 'error' as const,
          clause: partClause(ctx.part, { 1: '6.2.4', 2: '6.2.9', 4: '6.2.8.1' }), object,
          message: `Form XObject /OPI is prohibited in PDF/A-${ctx.part}.` }]
      : []);

/** ISO 19005-2/-3 6.2.3-3 exempts a PDF/X output intent — its test is
 *  `S != 'GTS_PDFX' || containsDestOutputProfileRef == false` — where ISO
 *  19005-4's 6.2.3-3 is unconditional. Those standards permit a PDF/X intent
 *  beside the PDF/A one, and /DestOutputProfileRef is legal THERE. */
export function destProfileRefExempt(part: 1 | 2 | 3 | 4, s: string | undefined): boolean {
  return part !== 4 && s === 'GTS_PDFX';
}

const outputIntentKeysRule: Rule = (ctx) => {
  if (ctx.part === 1) return [];
  const ois = ctx.R(ctx.catalog.get('OutputIntents'));
  if (!isArray(ois)) return [];
  const issues: ValidationIssue[] = [];
  const clause = partClause(ctx.part, { 2: '6.2.3', 4: '6.2.3' });
  let pdfaCount = 0;
  for (const e of ois) {
    const oi = ctx.R(e);
    if (!isDict(oi)) continue;
    const s = nameOf(ctx, oi, 'S');
    if (s === 'GTS_PDFA1') pdfaCount++;
    if (oi.get('DestOutputProfileRef') !== undefined && !destProfileRefExempt(ctx.part, s)) {
      issues.push({ rule: 'OutputIntentKeys', severity: 'error', clause,
        object: isRef(e) ? e : undefined,
        message: `OutputIntent /DestOutputProfileRef is prohibited in PDF/A-${ctx.part}.` });
    }
  }
  // Part-4 only: parts 2/3 require `sameOutputProfileIndirect` instead, which
  // outputIntentRule already reports as 'multiple'. Backporting this count
  // would report a shape ISO 19005-2/-3 permit.
  if (ctx.part === 4 && pdfaCount > 1) {
    issues.push({ rule: 'OutputIntentKeys', severity: 'error', clause,
      message: `The /OutputIntents array holds ${pdfaCount} PDF/A output intents; at most one is permitted.` });
  }
  return issues;
};

/** ISO 19005-4 6.2.9-2.
 *
 *  Recorded limitation: "contains transparency" is detected from the page's own
 *  /Group /S /Transparency declaration ONLY. Transparency arising solely from an
 *  ExtGState soft mask or a constant alpha below 1 is not attributed to a page
 *  here, because extGStates(ctx) is document-wide. */
const transparencyBlendingSpaceRule: Rule = (ctx) => {
  // ISO 19005-2/-3 6.2.10-2 and -4 6.2.9-2. Part 1 bans transparency groups
  // outright (transparencyRule), so the /CS rule has nothing to attach to.
  if (ctx.part === 1) return [];
  // The clause only bites when the document declares no PDF/A output intent.
  if (pdfaOutputIntentProfile(ctx) !== 'missing') return [];
  const issues: ValidationIssue[] = [];
  for (const page of ctx.doc.Pages) {
    if (page.Dict.get('OutputIntents') !== undefined) continue; // a page intent satisfies it
    const grp = ctx.R(page.Dict.get('Group'));
    if (!isDict(grp) || nameOf(ctx, grp, 'S') !== 'Transparency') continue;
    if (grp.get('CS') === undefined) {
      issues.push({ rule: 'TransparencyBlendingSpace', severity: 'error',
        clause: partClause(ctx.part, { 2: '6.2.10', 4: '6.2.9' }), page,
        message: 'Page declares a transparency group but neither the document nor the page has a PDF/A output intent and the group has no /CS blending colour space.' });
    }
  }
  return issues;
};

// ---- PDF/A-4 (ISO 19005-4) catalog rules -----------------------------------

const infoRestrictionRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const infoObj = ctx.doc.trailer.get('Info');
  if (infoObj === undefined) return [];
  const issues: ValidationIssue[] = [];
  const object = isRef(infoObj) ? infoObj : undefined;
  // 6.1.3-4: PDF 2.0 deprecates /Info, so PDF/A-4 permits it only as the
  // companion of a catalog /PieceInfo.
  if (ctx.catalog.get('PieceInfo') === undefined) {
    issues.push({ rule: 'InfoRestriction', severity: 'error', clause: 'ISO 19005-4 §6.1.3', object,
      message: 'Trailer /Info is present but the catalog has no /PieceInfo; PDF/A-4 permits /Info only alongside one.' });
  }
  // 6.1.3-5: and then it may hold nothing but /ModDate.
  const info = ctx.R(infoObj);
  if (isDict(info)) {
    for (const k of info.keys()) {
      if (k !== 'ModDate') {
        issues.push({ rule: 'InfoRestriction', severity: 'error', clause: 'ISO 19005-4 §6.1.3', object,
          message: `Document information dictionary contains /${k}; PDF/A-4 permits only /ModDate.` });
      }
    }
  }
  return issues;
};

const permissionsRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const perms = ctx.R(ctx.catalog.get('Perms'));
  if (!isDict(perms)) return [];
  return [...perms.keys()].filter((k) => k !== 'DocMDP').map((k) => ({
    rule: 'Permissions', severity: 'error' as const, clause: 'ISO 19005-4 §6.1.11',
    message: `Catalog /Perms contains /${k}; PDF/A-4 permits only /DocMDP.`,
  }));
};

/** ISO 19005-2/-3 6.4.2-2 and -4 6.4.2-1. Absent from the part-1 profile. */
const needsRenderingRule: Rule = (ctx) => {
  if (ctx.part === 1) return [];
  if (ctx.catalog.get('NeedsRendering') === undefined) return [];
  return [{ rule: 'NeedsRendering', severity: 'error',
    clause: partClause(ctx.part, { 2: '6.4.2', 4: '6.4.2' }),
    message: `Catalog /NeedsRendering is prohibited in PDF/A-${ctx.part}.` }];
};

const requirementsRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  if (ctx.catalog.get('Requirements') === undefined) return [];
  return [{ rule: 'Requirements', severity: 'error', clause: 'ISO 19005-4 §6.12',
    message: 'Catalog /Requirements is prohibited in PDF/A-4.' }];
};

const alternatePresentationsRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('AlternatePresentations') !== undefined) {
    issues.push({ rule: 'AlternatePresentations', severity: 'error', clause: 'ISO 19005-4 §6.11',
      message: '/Names /AlternatePresentations is prohibited in PDF/A-4.' });
  }
  for (const page of ctx.doc.Pages) {
    if (page.Dict.get('PresSteps') !== undefined) {
      issues.push({ rule: 'AlternatePresentations', severity: 'error', clause: 'ISO 19005-4 §6.11', page,
        message: 'Page /PresSteps is prohibited in PDF/A-4.' });
    }
  }
  return issues;
};

// ---- PDF/A-4 embedded files ------------------------------------------------

const embeddedFileSpecRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  for (const [object, obj] of allObjects(ctx)) {
    if (!isDict(obj)) continue;
    if (nameOf(ctx, obj, 'Type') !== 'Filespec' || obj.get('EF') === undefined) continue;
    // 6.9-2 and 6.9-4.
    for (const k of ['F', 'UF', 'AFRelationship']) {
      if (obj.get(k) === undefined) {
        issues.push({ rule: 'EmbeddedFileSpec', severity: 'error', clause: 'ISO 19005-4 §6.9', object,
          message: `Embedded-file specification has no /${k}.` });
      }
    }
    // 6.9-1: the stream itself must declare a MIME type.
    const ef = ctx.R(obj.get('EF'));
    if (!isDict(ef)) continue;
    for (const v of ef.values()) {
      const stream = ctx.R(v);
      if (isStream(stream) && stream.dict.get('Subtype') === undefined) {
        issues.push({ rule: 'EmbeddedFileSpec', severity: 'error', clause: 'ISO 19005-4 §6.9',
          object: isRef(v) ? v : object,
          message: 'Embedded file stream has no /Subtype MIME type.' });
      }
    }
  }
  return issues;
};

/** ISO 19005-4 6.9-5, and the one place PDF/A-4f DEMANDS something rather than
 *  relaxing something: a 4f file must actually carry an embedded file. */
const embeddedFilesRequiredRule: Rule = (ctx) => {
  if (ctx.part !== 4 || ctx.level !== 'f') return [];
  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('EmbeddedFiles') !== undefined) return [];
  return [{ rule: 'EmbeddedFilesRequired', severity: 'error', clause: 'ISO 19005-4 §6.9',
    message: 'A PDF/A-4f file must have an /EmbeddedFiles entry in the catalog name dictionary.' }];
};

/** ISO 19005-4 6.9-3 — base '4' only; 4e and 4f drop the rule, which is the
 *  whole point of 4f. We cannot decide it: recursive PDF/A validation of the
 *  embedded bytes is outside this validator's documented scope. Reported as a
 *  WARNING rather than passed over, because silence reads as 'we checked and it
 *  is fine', which is the one answer that is certainly wrong. */
const embeddedFileConformanceRule: Rule = (ctx) => {
  if (ctx.part !== 4 || ctx.level !== '') return [];
  const issues: ValidationIssue[] = [];
  for (const [object, obj] of allObjects(ctx)) {
    if (!isDict(obj)) continue;
    if (nameOf(ctx, obj, 'Type') !== 'Filespec' || obj.get('EF') === undefined) continue;
    issues.push({ rule: 'EmbeddedFileConformance', severity: 'warning', clause: 'ISO 19005-4 §6.9', object,
      message: 'PDF/A-4 requires every embedded file to conform to ISO 19005-1, -2 or -4; this validator does not verify embedded files.' });
  }
  return issues;
};

const RULES: Rule[] = [
  encryptionRule, fileIdRule, versionRule, externalStreamRule, lzwRule,
  psXObjectRule, refXObjectRule, optionalContentRule,
  metadataRule, pdfaIdRule, xmpInfoConsistencyRule,
  infoRestrictionRule, permissionsRule, needsRenderingRule,
  requirementsRule, alternatePresentationsRule,
  fontEmbeddedRule, fontEncodingRule, fontCidSetRule, toUnicodeRule, toUnicodeContentRule,
  outputIntentRule, iccBasedNRule, deviceColorRule,
  transparencyRule, blendModeRule,
  extGStateKeysRule, halftoneRule, imageKeysRule, formXObjectOpiRule,
  outputIntentKeysRule, transparencyBlendingSpaceRule,
  annotationAppearanceRule, annotationSubtypeRule, annotationFlagsRule, annotationOpacityRule,
  appearanceKeysRule, widgetActionRule, ocConfigRule,
  actionsRule, additionalActionsRule, needAppearancesRule, xfaRule,
  imageFilterRule, imageInterpolateRule, renderingIntentRule,
  embeddedFileSpecRule, embeddedFilesRequiredRule, embeddedFileConformanceRule,
];
