import type { Document } from './document.js';
import { PdfDict, PdfObject, isDict } from './types.js';
import { validatePdfUa } from './structvalidate.js';
import { STANDARD_STRUCTURE_TYPES } from './struct.js';
import type { StructElement } from './struct.js';
import type { ConvertAction, ConversionReport } from './conversion.js';

export interface PdfUaConvertOptions {
  /** Catalog /Lang (e.g. 'en-US'); resolves NaturalLanguage. Never fabricated. */
  lang?: string;
  /** Fallback /Info /Title, used only when no title is already present. */
  title?: string;
  /** Custom-role -> standard-type mappings added to /StructTreeRoot /RoleMap. */
  roleMap?: Record<string, string>;
}

interface Uctx {
  doc: Document;
  catalog: PdfDict;
  opts: PdfUaConvertOptions;
  R(o: PdfObject | undefined): PdfObject;
}

type Pass = (ctx: Uctx) => ConvertAction[];

/** Mark a tagged document as such: /MarkInfo /Marked true. No struct tree ->
 *  no-op (Tagged stays unresolved; tagging is never fabricated). */
const markedPass: Pass = (ctx) => {
  if (ctx.doc.GetStructTree() === null) return [];
  let mi = ctx.R(ctx.catalog.get('MarkInfo'));
  if (!isDict(mi)) { mi = new Map<string, PdfObject>(); ctx.catalog.set('MarkInfo', mi); }
  if ((mi as PdfDict).get('Marked') === true) return [];
  (mi as PdfDict).set('Marked', true);
  ctx.doc.markModified();
  return [{ rule: 'Tagged', action: 'Set catalog /MarkInfo /Marked true.' }];
};

/** Set the catalog /Lang from opts.lang, resolving NaturalLanguage document-wide.
 *  Omitted lang -> no-op; a language is never invented. */
const langPass: Pass = (ctx) => {
  const lang = ctx.opts.lang;
  if (lang === undefined || ctx.doc.Lang === lang) return [];
  ctx.doc.Lang = lang; // setter writes catalog /Lang + markModified
  return [{ rule: 'NaturalLanguage', action: `Set catalog /Lang to '${lang}'.` }];
};

/** Ensure a document title. Keep any non-empty /Info /Title or XMP dc:title;
 *  else set /Info /Title from opts.title. No title available -> no-op. */
const titlePass: Pass = (ctx) => {
  const has = (s?: string) => s !== undefined && s.trim() !== '';
  if (has(ctx.doc.GetMetadata().title) || has(ctx.doc.GetXmp().title)) return [];
  const t = ctx.opts.title;
  if (t === undefined) return [];
  ctx.doc.SetMetadata({ title: t });
  return [{ rule: 'DocumentTitle', action: `Set /Info /Title to '${t}'.` }];
};

/** Set catalog /ViewerPreferences /DisplayDocTitle true (creating the dict).
 *  One writer for the flag, shared with Document.AddMarkdown's `title` option. */
const displayDocTitlePass: Pass = (ctx) => {
  if (ctx.doc.DisplayDocTitle) return [];
  ctx.doc.DisplayDocTitle = true;
  return [{ rule: 'DisplayDocTitle', action: 'Set /ViewerPreferences /DisplayDocTitle true.' }];
};

/** Add opts.roleMap entries to /StructTreeRoot /RoleMap, but only for custom
 *  roles actually used in the tree, not already resolvable, whose target is a
 *  standard type. Never adds dead or non-standard mappings. */
const roleMapPass: Pass = (ctx) => {
  const map = ctx.opts.roleMap;
  const tree = ctx.doc.GetStructTree();
  if (!map || tree === null) return [];
  const used = new Set<string>();
  const walk = (els: StructElement[]): void => {
    for (const e of els) { used.add(e.Type); walk(e.Children); }
  };
  walk(tree.Children);
  const actions: ConvertAction[] = [];
  for (const [custom, standard] of Object.entries(map)) {
    if (!used.has(custom)) continue;                                  // dead entry
    if (STANDARD_STRUCTURE_TYPES.has(tree.ResolveRole(custom))) continue; // already ok
    if (!STANDARD_STRUCTURE_TYPES.has(standard)) continue;           // target not standard
    tree.RegisterRole(custom, standard);
    actions.push({ rule: 'StandardType', action: `Mapped /RoleMap '${custom}' -> '${standard}'.` });
  }
  return actions;
};

/** Clear /MarkInfo /Suspects when true (silences the Suspects warning). */
const suspectsPass: Pass = (ctx) => {
  const mi = ctx.R(ctx.catalog.get('MarkInfo'));
  if (!isDict(mi) || mi.get('Suspects') !== true) return [];
  mi.set('Suspects', false);
  ctx.doc.markModified();
  return [{ rule: 'Suspects', action: 'Cleared catalog /MarkInfo /Suspects.' }];
};

/** Write the required PDF/UA-1 identification metadata (pdfuaid:part 1). */
const identificationPass: Pass = (ctx) => {
  ctx.doc.SetXmp({ pdfuaPart: 1 });
  return [{ rule: 'PdfuaIdentification', action: 'Wrote pdfuaid:part 1 XMP identification.' }];
};

const PASSES: Pass[] = [
  markedPass, titlePass, displayDocTitlePass, langPass, roleMapPass, suspectsPass, identificationPass,
];

/** Remediate `doc` toward PDF/UA-1, then re-validate. The facade supplies the
 *  catalog (mirrors validatePdfUa). Mutates the live model in place. */
export function convertToPdfUa(
  doc: Document, catalog: PdfDict, opts: PdfUaConvertOptions = {},
): ConversionReport {
  const ctx: Uctx = { doc, catalog, opts, R: (o) => doc.resolve(o) };
  const applied: ConvertAction[] = [];
  for (const pass of PASSES) applied.push(...pass(ctx));
  const unresolved = validatePdfUa(doc, catalog).Errors;
  return { applied, unresolved, passed: unresolved.length === 0 };
}
