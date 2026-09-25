import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isDict, isName, name } from './types.js';
import { validatePdfUa, type PdfUaPart } from './structvalidate.js';
import { STANDARD_STRUCTURE_TYPES } from './struct.js';
import type { StructElement } from './struct.js';
import { PDF20_NS } from './structns.js';
import type { ConvertAction, ConversionReport } from './conversion.js';
import { describeXmpPackets } from './pdfaextfix.js';

export interface PdfUaConvertOptions {
  /** Which part of ISO 14289 to target: 1 (the default) or 2. */
  part?: PdfUaPart;
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
  part: PdfUaPart;
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

/** Write the required PDF/UA identification metadata. Part 2 additionally
 *  carries pdfuaid:rev, the four-digit year of the revision (ISO 14289-2:2024). */
const identificationPass: Pass = (ctx) => {
  if (ctx.part === 2) {
    ctx.doc.SetXmp({ pdfuaPart: 2, pdfuaRev: 2024 });
    return [{ rule: 'PdfuaIdentification',
      action: 'Wrote pdfuaid:part 2 and pdfuaid:rev 2024 XMP identification.' }];
  }
  ctx.doc.SetXmp({ pdfuaPart: 1 });
  return [{ rule: 'PdfuaIdentification', action: 'Wrote pdfuaid:part 1 XMP identification.' }];
};

/** A PDF/A document stays PDF/A (`o6uu.6`): `pdfuaid` is not a predefined
 *  schema for ISO 19005-1..3, so writing it obliges a description. Only when
 *  the packet claims one of those parts — a plain document gets no extension
 *  schema it does not need. Note it runs `ConvertToPdfA`'s own description
 *  pass, so it describes EVERY property still undescribed that it can state
 *  truthfully, not only `pdfuaid` (`o6uu.11`) — the document then passes the
 *  PDF/A rule, which is the point, and `ConvertToPdfX` does the same. */
const pdfaExtensionPass: Pass = (ctx) => {
  const part = ctx.doc.GetXmp().pdfaPart;
  return part === 1 || part === 2 || part === 3 ? describeXmpPackets(ctx.doc, part) : [];
};

/** PDF/UA-2 is defined over PDF 2.0, so declare it. serializer.ts's
 *  headerVersion() reads the catalog /Version (invariant 909q), so this is the
 *  whole of writing a 2.0 header.
 *
 *  **Note, a DELIBERATE DIVERGENCE:** there is NO version rule in the anchor's
 *  90, so we write this and validate nothing for it — adding a validator rule
 *  veraPDF does not carry would make our report disagree with it on a
 *  conformant file. The shape `72nc.1` records for psXObjectRule. */
const versionPass: Pass = (ctx) => {
  if (ctx.part !== 2) return [];
  const cur = ctx.R(ctx.catalog.get('Version'));
  if (isName(cur) && cur.name === '2.0') return [];
  ctx.catalog.set('Version', name('2.0'));
  ctx.doc.markModified();
  return [{ rule: 'Version', action: 'Set catalog /Version to 2.0.' }];
};

/** ISO 14289-2 8.2.1-2: every structure element dictionary shall contain /P. */
const parentPass: Pass = (ctx) => {
  if (ctx.part !== 2) return [];
  const tree = ctx.doc.GetStructTree();
  if (tree === null) return [];
  let fixed = 0;
  const walk = (parentRef: PdfRef | undefined, els: StructElement[]): void => {
    for (const el of els) {
      if (!el.Dict.has('P') && parentRef !== undefined) {
        el.Dict.set('P', parentRef); ctx.doc.markModified(); fixed++;
      }
      walk(el.Ref, el.Children);
    }
  };
  walk(tree.Ref, tree.Children);
  return fixed === 0 ? []
    : [{ rule: 'StructParent', action: `Wrote /P onto ${fixed} structure element(s).` }];
};

/** ISO 14289-2 8.2.5.2: a single Document element as the tree root's only
 *  child, in the PDF 2.0 namespace.
 *
 *  Where the root already holds exactly one Document this is one /NS write.
 *  Otherwise a Document is created and every existing top-level child is
 *  re-parented under it with MoveTo (`q7hc.3`) — mechanical, deterministic and
 *  ORDER-PRESERVING because they move in order. MoveTo materializes an
 *  inherited /Pg first, so the re-parenting cannot re-point anyone's marked
 *  content. */
const documentElementPass: Pass = (ctx) => {
  if (ctx.part !== 2) return [];
  const tree = ctx.doc.GetStructTree();
  if (tree === null) return [];
  const actions: ConvertAction[] = [];
  const kids = tree.Children;
  let docEl = kids.length === 1 && kids[0].StandardType === 'Document' ? kids[0] : undefined;

  if (docEl === undefined) {
    const created = tree.Append('Document', { ns: PDF20_NS });
    // Re-read: Append pushed the new element onto /K, so the originals are
    // every child that is not the one just created.
    const originals = tree.Children.filter((c) => c.Dict !== created.Dict);
    for (const child of originals) child.MoveTo(created);
    docEl = created;
    actions.push({ rule: 'DocumentElement',
      action: `Wrapped ${originals.length} top-level element(s) in a Document element.` });
  }
  if (docEl.Namespace !== PDF20_NS) {
    docEl.Namespace = PDF20_NS;
    actions.push({ rule: 'DocumentElement',
      action: 'Put the Document element in the PDF 2.0 standard structure namespace.' });
  }
  return actions;
};

const PASSES: Pass[] = [
  markedPass, titlePass, displayDocTitlePass, langPass, roleMapPass, suspectsPass,
  // Part 2 only; each returns [] at part 1, so the part-1 action list is
  // byte-identical.
  versionPass, parentPass, documentElementPass,
  identificationPass, pdfaExtensionPass,
];

/** Remediate `doc` toward PDF/UA-1, then re-validate. The facade supplies the
 *  catalog (mirrors validatePdfUa). Mutates the live model in place. */
export function convertToPdfUa(
  doc: Document, catalog: PdfDict, opts: PdfUaConvertOptions = {},
): ConversionReport {
  const part = opts.part ?? 1;
  const ctx: Uctx = { doc, catalog, part, opts, R: (o) => doc.resolve(o) };
  const applied: ConvertAction[] = [];
  for (const pass of PASSES) applied.push(...pass(ctx));
  // **Invariant:** the re-validation part MUST match the conversion part.
  // Leaving it at the default reports a part-2 conversion as passing while the
  // part-2 rules were never asked — and convertToPdfUa's contract is that
  // `unresolved` mirrors the validator exactly.
  const unresolved = validatePdfUa(doc, catalog, part).Errors;
  return { applied, unresolved, passed: unresolved.length === 0 };
}
