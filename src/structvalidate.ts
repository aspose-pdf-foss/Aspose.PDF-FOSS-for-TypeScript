import type { Document } from './document.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { visitContent } from './text.js';
import { PdfDict, PdfRef, isDict } from './types.js';
import { effectiveListNumbering, readOwnerName } from './structattr.js';
import { LinkAnnotation } from './annotation.js';
import { buildStructGrid, headerConnectivity, type GridCell } from './structgrid.js';
import { ValidationReport, type ValidationIssue, type Severity } from './validation.js';
import { isStandardTypeIn, STANDARD_STRUCTURE_TYPES } from './structtype.js';
import { namespaceUriOf, PDF20_NS, MATHML_NS } from './structns.js';
import {
  uaClause, type PdfUaPart, type Rule, type UaCtx, type WalkedNode,
} from './uarule.js';
import { ANNOT_RULES } from './uaannot.js';
import { FONT_RULES } from './uafont.js';
import { TEXT_RULES } from './uatext.js';
import { DOC_RULES } from './uadoc.js';

// Re-export so existing importers of these from structvalidate keep working.
export { ValidationReport, uaClause };
export type { ValidationIssue, Severity, PdfUaPart, UaCtx, Rule };

/** Run the curated PDF/UA rule set over `doc`. `catalog` is the document catalog
 *  dict (the facade supplies it so catalog-only rules need no public accessor).
 *
 *  **Invariant (`q7hc.4`):** the part-2 rules are APPENDED to `RULES`, so the
 *  part-1 report order is byte-identical. Order is observable through
 *  `ValidationReport.Issues` and no pre-existing assertion checks sequence, only
 *  membership — `test/pdfua-part1-identity.test.ts` is the only thing in the
 *  suite that can see a reordering, and it was committed BEFORE this refactor. */
export function validatePdfUa(
  doc: Document, catalog: PdfDict, part: PdfUaPart = 1,
): ValidationReport {
  const tree = doc.GetStructTree();
  if (!tree) {
    return new ValidationReport([{
      rule: 'Tagged', severity: 'error', clause: 'ISO 14289-1 §7.1',
      message: 'Document is not tagged: no /StructTreeRoot in the catalog.',
    }]);
  }
  const ctx: UaCtx = { doc, catalog, part, tree, nodes: walkTree(tree) };
  const issues: ValidationIssue[] = [];
  for (const rule of RULES) issues.push(...rule(ctx));
  return new ValidationReport(issues);
}

// ---- rules -----------------------------------------------------------------

/** Catalog /MarkInfo /Marked must be true. */
const markedRule: Rule = (ctx) => {
  if (ctx.doc.IsTagged) return [];
  return [{
    rule: 'Tagged', severity: 'error', clause: 'ISO 14289-1 §7.1',
    message: 'Catalog /MarkInfo /Marked is not true.',
  }];
};

/** DocumentTitle — Info /Title or XMP dc:title must be non-empty. */
const documentTitleRule: Rule = (ctx) => {
  const title = ctx.doc.GetMetadata().title ?? ctx.doc.GetXmp().title;
  if (title && title.trim() !== '') return [];
  return [{
    rule: 'DocumentTitle', severity: 'error', clause: 'ISO 14289-1 §7.1 (Matterhorn 06-003)',
    message: 'Document has no title (/Info /Title and XMP dc:title are both empty).',
  }];
};

/** DisplayDocTitle — /ViewerPreferences /DisplayDocTitle must be true. */
const displayDocTitleRule: Rule = (ctx) => {
  const vp = ctx.doc.resolve(ctx.catalog.get('ViewerPreferences'));
  const ddt = isDict(vp) ? ctx.doc.resolve(vp.get('DisplayDocTitle')) : undefined;
  if (ddt === true) return [];
  return [{
    rule: 'DisplayDocTitle', severity: 'error', clause: 'ISO 14289-1 §7.1 (Matterhorn 07-001)',
    message: 'Catalog /ViewerPreferences /DisplayDocTitle is not true.',
  }];
};

/** Suspects — /MarkInfo /Suspects must not be true (warning). */
const suspectsRule: Rule = (ctx) => {
  const mi = ctx.doc.resolve(ctx.catalog.get('MarkInfo'));
  if (!isDict(mi) || ctx.doc.resolve(mi.get('Suspects')) !== true) return [];
  return [{
    rule: 'Suspects', severity: 'warning', clause: 'Matterhorn 01-005',
    message: 'Catalog /MarkInfo /Suspects is true: tagging may be unreliable.',
  }];
};

/** The per-element checks: standard type, illustration alt text, natural
 *  language, and table/list nesting.
 *
 *  **Invariant:** this stays ONE rule over ONE loop. Splitting it into a rule
 *  per check would interleave the report differently — an element's four
 *  findings would no longer be adjacent — which is exactly what the part-1
 *  order fence forbids. */
const structureRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  for (const { element, parentType } of ctx.nodes) {
    if (!element.IsStandardType) {
      issues.push({
        rule: 'StandardType', severity: 'error', clause: 'Matterhorn 02-001', element,
        message: `Structure type '${element.Type}' is not a standard type and is not mapped via /RoleMap.`,
      });
    }
    if (ILLUSTRATION.has(element.StandardType)) {
      const alt = element.Alt; const actual = element.ActualText;
      if (!(alt && alt.trim()) && !(actual && actual.trim())) {
        issues.push({
          rule: 'IllustrationAlt', severity: 'error', clause: 'ISO 14289-1 §7.3 (Matterhorn 13-004)', element,
          message: `${element.StandardType} element has no /Alt or /ActualText.`,
        });
      }
    }
    if (isTextBearing(element) && element.EffectiveLang === undefined) {
      issues.push({
        rule: 'NaturalLanguage', severity: 'error', clause: 'ISO 14289-1 §7.2 (Matterhorn 11-001)', element,
        message: 'Text-bearing element has no resolvable natural language (/Lang).',
      });
    }
    const st = element.StandardType;
    if (st === 'TR' && !(parentType !== null && TR_PARENTS.has(parentType))) {
      issues.push({
        rule: 'TableStructure', severity: 'error', clause: 'Matterhorn checkpoint 09 (tables)', element,
        message: `TR must be a child of Table/THead/TBody/TFoot, not '${parentType ?? 'root'}'.`,
      });
    }
    if ((st === 'TH' || st === 'TD') && parentType !== 'TR') {
      issues.push({
        rule: 'TableStructure', severity: 'error', clause: 'Matterhorn checkpoint 09 (tables)', element,
        message: `${st} must be a child of TR, not '${parentType ?? 'root'}'.`,
      });
    }
    if (st === 'LI' && parentType !== 'L') {
      issues.push({
        rule: 'ListStructure', severity: 'error', clause: 'Matterhorn checkpoint 10 (lists)', element,
        message: `LI must be a child of L, not '${parentType ?? 'root'}'.`,
      });
    }
    if ((st === 'Lbl' || st === 'LBody') && parentType !== 'LI') {
      issues.push({
        rule: 'ListStructure', severity: 'error', clause: 'Matterhorn checkpoint 10 (lists)', element,
        message: `${st} must be a child of LI, not '${parentType ?? 'root'}'.`,
      });
    }
  }
  return issues;
};

/** HeadingNesting — numbered headings must not skip a level descending. */
const headingNestingRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  let prevLevel = 0;
  for (const { element } of ctx.nodes) {
    const level = headingLevel(element.StandardType);
    if (level === 0) continue;
    if (level > prevLevel + 1) {
      issues.push({
        rule: 'HeadingNesting', severity: 'error', clause: 'Matterhorn 14-002', element,
        message: `Heading ${element.StandardType} skips a level (previous numbered heading was H${prevLevel || 0}).`,
      });
    }
    prevLevel = level;
  }
  return issues;
};

/** UntaggedContent — page content that is neither tagged nor artifacted.
 *
 *  **Invariant (`q7hc.2`):** "tagged" means the MCID RESOLVES to an element
 *  through the /ParentTree, not merely that the content carries one. A `BDC`
 *  whose slot was released — or a third-party file whose mapping was never
 *  written — is content in no structure tree, and the older
 *  `mcid === undefined` test called it tagged and said nothing.
 *
 *  **Note, measured:** widening this reddened NOTHING across the suite,
 *  because every MCID this library authors resolves. It is held by
 *  `test/helpers/build-dangling-mcid-pdf.ts` alone. */
const untaggedContentRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  for (const page of ctx.doc.Pages) {
    const spRaw = ctx.doc.resolve(page.Dict.get('StructParents'));
    const sp = typeof spRaw === 'number' ? spRaw : undefined;
    // Memoized per page: ElementFor walks a number tree, and asking it per
    // glyph would make validation quadratic in a page's marked content.
    const memo = new Map<number, boolean>();
    const tagged = (mcid: number | undefined): boolean => {
      if (mcid === undefined || sp === undefined) return false;
      let hit = memo.get(mcid);
      if (hit === undefined) { hit = ctx.tree.ElementFor(sp, mcid) !== undefined; memo.set(mcid, hit); }
      return hit;
    };
    let untagged = false;
    visitContent(ctx.doc, page, {
      glyph: (e) => { if (!tagged(e.mcid) && !e.artifact) untagged = true; },
      image: (e) => { if (!tagged(e.mcid) && !e.artifact) untagged = true; },
      path: (e) => { if (!tagged(e.mcid) && !e.artifact) untagged = true; },
    });
    if (untagged) {
      issues.push({
        rule: 'UntaggedContent', severity: 'warning', clause: 'Matterhorn 01-006', page,
        message: 'Page has visible content (text, image or vector) that is neither tagged nor marked as an artifact.',
      });
    }
  }
  return issues;
};

// ---- part 2 (ISO 14289-2) --------------------------------------------------
//
// Transcribed from veraPDF/veraPDF-validation-profiles@integration PDF_UA/2/**,
// fetched 2026-09-15. That is a TRANSCRIPTION and not a runnable oracle: the
// suite proves this agrees with our reading of the profile, and nothing about
// whether either matches ISO 14289-2. `72nc.1`'s ceiling.

/** 5-1..5-5: the PDF/UA identification schema — `pdfuaid:part`, and
 *  `pdfuaid:rev` at part 2.
 *
 *  **Invariant (`q7hc.4.5`): it runs at BOTH parts, and the two clauses are not
 *  the same rule.** PDF_UA/1 clause 5 requires identification and `part == 1`
 *  and has NO rev rule at all — UA-1 carries `amd` and `corr` where UA-2
 *  carries `rev` — so requiring a rev at part 1 would report on every
 *  conformant UA-1 document, including the ones `ConvertToPdfUa` writes.
 *
 *  **Invariant: a WARNING, not an error, at both parts.** Every rule of clause
 *  5 is tagged `minor` in the anchor — at part 1 AND part 2 — which is the
 *  mapping `TabOrder` already follows. It shipped as an error from `q7hc.4`
 *  until `q7hc.4.5`; that was a transcription defect, and correcting it is what
 *  lets a document missing identification still report `Passed`. That matters
 *  beyond tidiness: an authored tagged document carries no `pdfuaid` (writing
 *  one would be a conformance CLAIM the library has no business making on the
 *  author's behalf), and README promises such a document passes
 *  `ValidatePdfUa` outright.
 *
 *  **Note 5-3, 5-4 and 5-5 need no code, and that is a NEAR-EQUIVALENCE rather
 *  than an omission.** They check that `part`, `amd`/`rev` and `corr` carry the
 *  `pdfuaid` namespace prefix; `xmp.ts` matches the literal `pdfuaid:` spelling,
 *  so a value under any other prefix is simply not found and 5-1 reports
 *  instead of 5-3. The same document is reported either way, and separating the
 *  two would mean modelling XMP namespace prefixes for no change in outcome. */
const identificationRule: Rule = (ctx) => {
  const xmp = ctx.doc.GetXmp();
  const mk = (message: string): ValidationIssue[] => [{
    rule: 'PdfuaIdentification', severity: 'warning',
    clause: uaClause(ctx.part, { 1: '5', 2: '5' }), message,
  }];
  if (xmp.pdfuaPart === undefined)
    return mk('No PDF/UA identification: XMP has no pdfuaid:part.');
  if (xmp.pdfuaPart !== ctx.part)
    return mk(`XMP pdfuaid:part is '${xmp.pdfuaPart}', expected '${ctx.part}'.`);
  // `rev` is PART 2's alone; PDF_UA/1 clause 5 states no rev rule.
  if (ctx.part === 2 && xmp.pdfuaRev !== 2024)
    return mk(`XMP pdfuaid:rev is '${xmp.pdfuaRev ?? '(absent)'}', expected '2024'.`);
  return [];
};

/** 8.2.1-2: every structure element dictionary shall contain /P. */
const structParentRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.Dict.has('P')) continue;
    issues.push({
      rule: 'StructParent', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.1' }), element,
      message: `Structure element '${element.Type}' has no /P (parent) entry.`,
    });
  }
  return issues;
};

/** 8.2.4-1: every element shall belong to, or be role-mapped into, the PDF 1.7,
 *  PDF 2.0 or MathML namespace.
 *
 *  **Invariant, and it is the correction this issue turns on:** an element with
 *  NO /NS is in the PDF 1.7 namespace by default (ISO 32000-2 14.8.6), which is
 *  permitted — so a UA-1 tree carried over whole PASSES. Requiring per-element
 *  /NS, which this issue's own text asked for, rejects conformant documents. */
const structureNamespaceRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    const ns = namespaceUriOf(ctx.doc, element.Dict);
    if (isStandardTypeIn(element.StandardType, ns)) continue;
    issues.push({
      rule: 'StructureNamespace', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.4' }), element,
      message: `Structure type '${element.Type}' is not standard in `
        + `${ns === undefined ? 'the default (PDF 1.7) namespace' : `'${ns}'`} `
        + 'and is not role mapped to one that is.',
    });
  }
  return issues;
};

/** 8.2.4-2: a circular /RoleMap mapping shall not exist. */
const roleMapChainRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const seenTypes = new Set<string>();
  for (const { element } of ctx.nodes) {
    const t = element.Type;
    if (seenTypes.has(t)) continue;
    seenTypes.add(t);
    // resolveRole stops on a cycle and returns the name it stopped at; a cycle
    // is exactly "the chain did not end at a standard type, but the map still
    // has an entry for where it stopped".
    const end = element.StandardType;
    if (STANDARD_STRUCTURE_TYPES.has(end) || !ctx.tree.RoleMap.has(end)) continue;
    issues.push({
      rule: 'RoleMapChain', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.4' }), element,
      message: `/RoleMap chain from '${t}' is circular (stops at '${end}').`,
    });
  }
  return issues;
};

/** 8.2.5.2-1/-2: the tree root shall hold a SINGLE Document element as its only
 *  child, and that element's namespace shall be the PDF 2.0 one.
 *
 *  **Invariant:** the PDF 1.7 namespace is explicitly NOT enough. The obvious
 *  wrong reading — "any declared namespace" — accepts every carried-over UA-1
 *  tree, which is the case this rule exists to catch. */
const documentElementRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const kids = ctx.tree.Children;
  const mk = (message: string): ValidationIssue[] => [{
    rule: 'DocumentElement', severity: 'error',
    clause: uaClause(ctx.part, { 2: '8.2.5.2' }), message,
  }];
  if (kids.length !== 1)
    return mk(`Structure tree root has ${kids.length} top-level children; `
      + 'PDF/UA-2 requires a single Document element as its only child.');
  const only = kids[0];
  if (only.StandardType !== 'Document')
    return mk(`Structure tree root's only child is '${only.Type}', not a Document element.`);
  const ns = namespaceUriOf(ctx.doc, only.Dict);
  if (ns !== PDF20_NS)
    return mk(`The Document element's namespace is `
      + `${ns === undefined ? 'unstated (the default PDF 1.7 namespace)' : `'${ns}'`}, `
      + `expected '${PDF20_NS}'.`);
  return [];
};

/** 8.11.1-2: the catalog shall contain a /Metadata stream.
 *
 *  **Note the presence test is on the RAW dict**, not
 *  `resolve(get('Metadata')) !== undefined` — `doc.resolve(undefined)` returns
 *  `null` and `null !== undefined`, so the resolved form is true for every
 *  ABSENT key. The trap pdfxvalidate.ts and pdfatransparency.ts both record. */
const metadataRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  if (ctx.catalog.has('Metadata')) return [];
  return [{
    rule: 'Metadata', severity: 'error',
    clause: uaClause(ctx.part, { 2: '8.11.1' }),
    message: 'Catalog has no /Metadata XMP stream.',
  }];
};

// ---- part 2, ISO 14289-2 8.2.5 (`q7hc.4.1`) --------------------------------
//
// The per-type structure requirements. Transcribed from the same anchor, plus
// veraPDF/veraPDF-validation@integration's `gfse/` model classes where the
// profile states only a bare predicate.
//
// **Note 8.2.5.28.2-1 (a Figure shall carry /Alt or /ActualText) is ABSENT
// from this block on purpose.** `structureRule`'s `IllustrationAlt` already
// covers Figure/Formula/Form at BOTH parts, so that rule is SATISFIED rather
// than implemented — the one rule of the clause's 21 that is not silent at
// part 1. A part-2-only twin would report one missing /Alt twice.

/** 8.2.5.8-1: each TOCI shall identify its target through /Ref, on itself or on
 *  one of its DESCENDANT structure elements. */
const tociRefRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const anyRef = (el: StructElement): boolean =>
    el.References.length > 0 || el.Children.some(anyRef);
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'TOCI' || anyRef(element)) continue;
    issues.push({
      rule: 'TociRef', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.8' }), element,
      message: 'TOCI has no /Ref entry, on itself or on any descendant, so the '
        + 'entry identifies no target.',
    });
  }
  return issues;
};

/** 8.2.5.12-1: conforming files shall not use the H structure type. */
const headingHRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  return ctx.nodes.filter((n) => n.element.StandardType === 'H').map(({ element }) => ({
    rule: 'HeadingH', severity: 'error' as const,
    clause: uaClause(ctx.part, { 2: '8.2.5.12' }), element,
    message: 'The H structure type is prohibited in PDF/UA-2; use H1..Hn.',
  }));
};

/** 8.2.5.14-1: the Note structure type shall not be present unless role mapped
 *  into the PDF 2.0 namespace, where it does not exist — FENote replaces it. */
const noteProhibitedRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  return ctx.nodes.filter((n) => n.element.StandardType === 'Note').map(({ element }) => ({
    rule: 'NoteProhibited', severity: 'error' as const,
    clause: uaClause(ctx.part, { 2: '8.2.5.14' }), element,
    message: 'The Note structure type is prohibited in PDF/UA-2; use FENote.',
  }));
};

/** 8.2.5.23-1: a Ruby holds either RB,RT or RB,RP,RT,RP and nothing else. */
const rubySequenceRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'Ruby') continue;
    const seq = childTypes(element).join(',');
    if (seq === 'RB,RT' || seq === 'RB,RP,RT,RP') continue;
    issues.push({
      rule: 'RubySequence', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.23' }), element,
      message: `Ruby has the child sequence '${seq}', expected 'RB,RT' or 'RB,RP,RT,RP'.`,
    });
  }
  return issues;
};

/** 8.2.5.24-1: a Warichu holds WP,WT,WP and nothing else. */
const warichuSequenceRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'Warichu') continue;
    const seq = childTypes(element).join(',');
    if (seq === 'WP,WT,WP') continue;
    issues.push({
      rule: 'WarichuSequence', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.24' }), element,
      message: `Warichu has the child sequence '${seq}', expected 'WP,WT,WP'.`,
    });
  }
  return issues;
};

/** 8.2.5.27-1: a Caption shall be the FIRST or the LAST child of its parent.
 *
 *  **Note the profile spells this as a substring test** —
 *  `kidsStandardTypes.indexOf('&Caption&') < 0` over an `&`-joined list — which
 *  is exactly "not in any interior position", first and last included. */
const captionPositionRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    const types = childTypes(element);
    for (let i = 1; i < types.length - 1; i++) {
      if (types[i] !== 'Caption') continue;
      issues.push({
        rule: 'CaptionPosition', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.2.5.27' }), element,
        message: `Caption is child ${i + 1} of ${types.length}; it must be the `
          + 'first or the last.',
      });
      break;
    }
  }
  return issues;
};

/** 8.2.5.29-1: a MathML element shall occur only under a Formula — or under
 *  another MathML element, which is what `hasParentFormulaOrMathML` means, so
 *  only the ROOT of a MathML subtree has to sit under the Formula. */
const mathMlParentRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element, parent } of ctx.nodes) {
    if (namespaceUriOf(ctx.doc, element.Dict) !== MATHML_NS) continue;
    if (parent !== null
      && (parent.StandardType === 'Formula'
        || namespaceUriOf(ctx.doc, parent.Dict) === MATHML_NS)) continue;
    issues.push({
      rule: 'MathMLParent', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.29' }), element,
      message: `MathML element '${element.Type}' is not nested within a Formula element.`,
    });
  }
  return issues;
};

/** 8.2.5.25-2: real content inside an LI shall be enclosed in an Lbl or an
 *  LBody, so the LI itself owns no marked content. */
const listItemContentRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'LI' || element.ContentItems.length === 0) continue;
    issues.push({
      rule: 'ListItemContent', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.25' }), element,
      message: 'LI owns real content directly; it must be enclosed in an Lbl or an LBody.',
    });
  }
  return issues;
};

const NOTE_TYPES = new Set(['Footnote', 'Endnote', 'None']);

/** 8.2.5.14-2 and -3: the /Ref relation between a FENote and its citations
 *  shall close in BOTH directions.
 *
 *  -2 reports ORPHANS — elements that cite this note and are missing from its
 *  own /Ref; -3 reports GHOSTS — elements its /Ref names that do not cite it
 *  back. ONE rule computes both, because both need the same reverse index.
 *
 *  **Note the fixture trap:** a graph that is symmetric cannot separate the two
 *  at all, so each direction needs its own ONE-SIDED graph. */
const feNoteRefRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const key = (r: PdfRef): string => `${r.num} ${r.gen}`;
  // Who cites whom, by object key.
  const cites = new Map<string, Set<string>>();
  for (const { element } of ctx.nodes) {
    if (element.Ref === undefined) continue;
    cites.set(key(element.Ref), new Set(element.References.map(key)));
  }
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'FENote' || element.Ref === undefined) continue;
    const me = key(element.Ref);
    const mine = cites.get(me) ?? new Set<string>();

    const orphans = [...cites]
      .filter(([k, to]) => to.has(me) && !mine.has(k)).map(([k]) => k);
    if (orphans.length > 0) {
      issues.push({
        rule: 'FENoteRefOrphan', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.2.5.14' }), element,
        message: `FENote /Ref omits structure element(s) ${orphans.join(', ')}, `
          + 'which reference this FENote.',
      });
    }
    const ghosts = [...mine].filter((k) => !(cites.get(k)?.has(me) ?? false));
    if (ghosts.length > 0) {
      issues.push({
        rule: 'FENoteRefGhost', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.2.5.14' }), element,
        message: `FENote /Ref references structure element(s) ${ghosts.join(', ')}, `
          + 'which do not reference this FENote.',
      });
    }
  }
  return issues;
};

/** 8.2.5.14-4: a FENote's NoteType shall be Footnote, Endnote or None.
 *
 *  **Note an ABSENT NoteType PASSES.** `AttributeHelper.getNoteType` defaults it
 *  to `None`, which is in the permitted set — the obvious reading, that the
 *  attribute is required, has this backwards. It is read RAW, because the typed
 *  reader drops a value outside the enumeration and this rule has to report it. */
const feNoteTypeRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'FENote') continue;
    const nt = readOwnerName(ctx.doc, ctx.tree, element.Dict, 'FENote', 'NoteType') ?? 'None';
    if (NOTE_TYPES.has(nt)) continue;
    issues.push({
      rule: 'FENoteType', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.14' }), element,
      message: `FENote NoteType is '${nt}', expected Footnote, Endnote or None.`,
    });
  }
  return issues;
};

/** 8.2.5.25-1: where an LI carries an Lbl, the L shall state a ListNumbering
 *  other than None.
 *
 *  **Note the numbering is INHERITED** (`effectiveListNumbering`), so a nested
 *  list covered by an outer declaration does not report; and an ABSENT value
 *  reads as `None` and DOES, which is what makes the rule bite at all. */
const listNumberingRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'L') continue;
    const labelled = significantChildren(element).some(
      (li) => li.StandardType === 'LI'
        && significantChildren(li).some((k) => k.StandardType === 'Lbl'));
    if (!labelled) continue;
    if (effectiveListNumbering(ctx.doc, ctx.tree, element.Dict) !== 'None') continue;
    issues.push({
      rule: 'ListNumbering', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.25' }), element,
      message: 'List items carry Lbl elements, but no ListNumbering other than '
        + 'None is in force on the L element.',
    });
  }
  return issues;
};

/** 8.2.5.20-1 and -2: a link annotation used as real content shall sit in a Link
 *  or a Reference element, and links targeting DIFFERENT locations shall sit in
 *  separate ones.
 *
 *  **Note the first rule passes a link with NO structure parent** — the profile
 *  test is `... || structParentType == null || isArtifact == true`. An untagged
 *  link annotation does not report here; `UntaggedContent` is what covers it.
 *  It reads wrong and it is what the anchor says.
 *
 *  **Note, measured, and it is the redundant-defence trap:** that rule is held
 *  by a CONJUNCTION of the `/StructParent` type test and the
 *  `parent === undefined` test below it, so breaking either ALONE proves
 *  nothing. An absent `/StructParent` resolves to `null`, which the first test
 *  rejects — and were it not there, `ElementForObject` would find nothing and
 *  the second would reject it anyway. Removing both reddens exactly one case;
 *  removing either is GREEN. Do not read the suite as covering either line, and
 *  do not "simplify" one away. */
const linkRules: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  // Parent element object key -> the first target seen under it.
  const firstTarget = new Map<string, string>();
  for (const page of ctx.doc.Pages) {
    for (const annot of page.Annotations) {
      if (!(annot instanceof LinkAnnotation)) continue;
      const spRaw = ctx.doc.resolve(annot.Dict.get('StructParent'));
      if (typeof spRaw !== 'number') continue;          // not in the tree: passes
      const parent = ctx.tree.ElementForObject(spRaw);
      if (parent === undefined) continue;               // ditto
      const st = parent.StandardType;
      if (st !== 'Link' && st !== 'Reference') {
        issues.push({
          rule: 'LinkEnclosure', severity: 'error',
          clause: uaClause(ctx.part, { 2: '8.2.5.20' }), element: parent, page,
          message: `A Link annotation is nested within '${parent.Type}' `
            + `(standard type '${st}') instead of Link or Reference.`,
        });
        continue;
      }
      if (parent.Ref === undefined) continue;
      const pkey = `${parent.Ref.num} ${parent.Ref.gen}`;
      const target = linkTarget(annot);
      const seen = firstTarget.get(pkey);
      if (seen === undefined) { firstTarget.set(pkey, target); continue; }
      if (seen === target) continue;
      issues.push({
        rule: 'LinkTargets', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.2.5.20' }), element: parent, page,
        message: `Structure element '${parent.Type}' holds Link annotations that `
          + `target different locations ('${seen}' and '${target}').`,
      });
    }
  }
  return issues;
};

/** A link's target, as a string that compares equal for equal destinations.
 *
 *  **Invariant: it goes through `LinkAnnotation.Action` and `.Dest`, the PARSED
 *  forms, never the raw `/A` and `/Dest`.** `actions.ts` is the one owner of
 *  that grammar — the rule links, push buttons and `/AA` triggers already follow
 *  — so reading the dict here would be a second parser that can disagree with
 *  the first about one link. It also keeps this module free of `serialize.js`. */
function linkTarget(annot: LinkAnnotation): string {
  const a = annot.Action;
  if (a !== undefined && a.type === 'uri') return `uri:${a.uri}`;
  const d = annot.Dest;
  if (d !== undefined) return `dest:${JSON.stringify(d)}`;
  return '';
}

/** A table's rows, in order, with the index at the START and END of each row
 *  grouping — `GFSETable.getTR`'s `rowGroupingsIndexes`. */
function tableRows(table: StructElement): { rows: StructElement[]; boundaries: number[] } {
  const rows: StructElement[] = [];
  const boundaries: number[] = [];
  for (const kid of significantChildren(table)) {
    const t = kid.StandardType;
    if (t === 'TR') { rows.push(kid); continue; }
    if (t !== 'THead' && t !== 'TBody' && t !== 'TFoot') continue;
    boundaries.push(rows.length);
    for (const c of significantChildren(kid)) if (c.StandardType === 'TR') rows.push(c);
    boundaries.push(rows.length);
  }
  return { rows, boundaries };
}

/** One row's cells as the grid reads them.
 *
 *  **Note `/Scope` is read RAW**, because veraPDF's table-level gate counts a TH
 *  as scoped when it states ANY name, junk included — a validated read would
 *  examine cells the anchor does not. */
function gridCells(ctx: UaCtx, tr: StructElement): { cells: GridCell[]; els: StructElement[] } {
  const cells: GridCell[] = [];
  const els: StructElement[] = [];
  for (const el of significantChildren(tr)) {
    const t = el.StandardType;
    if (t !== 'TD' && t !== 'TH') continue;
    const ta = el.TableAttributes;
    cells.push({
      isHeader: t === 'TH',
      rowSpan: ta?.rowSpan ?? 1,
      colSpan: ta?.colSpan ?? 1,
      id: el.ID,
      scope: readOwnerName(ctx.doc, ctx.tree, el.Dict, 'Table', 'Scope'),
      headers: ta?.headers,
    });
    els.push(el);
  }
  return { cells, els };
}

/** 8.2.5.26-1..-6: table regularity and header connectivity.
 *
 *  **Invariant:** ONE rule over ONE grid build, because all six predicates are
 *  answers about the same placement — building it per rule would let them
 *  disagree about one table. The six REPORT under four distinct names, which is
 *  the profile's own split: 26-3/26-4 and 26-5/26-6 are complementary tests of
 *  one defect that differ only in whether the message can carry its counts.
 *
 *  **Invariant:** an IRREGULAR table is never asked about headers. The anchor
 *  sets `useHeadersAndIdOrScope` and returns, so the two never report together. */
const tableRules: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const clause = uaClause(ctx.part, { 2: '8.2.5.26' });

  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'Table') continue;
    const { rows, boundaries } = tableRows(element);
    const read = rows.map((tr) => gridCells(ctx, tr));
    const cells = read.map((r) => r.cells);
    const grid = buildStructGrid(cells, boundaries);
    const at = (a: { row: number; index: number }): StructElement | undefined =>
      read[a.row]?.els[a.index];

    const irr = grid.irregularity;
    if (irr !== undefined) {
      if (irr.kind === 'intersection') {
        for (const a of [irr.a, irr.b]) {
          issues.push({
            rule: 'TableCellIntersection', severity: 'error', clause,
            element: at(a) ?? element,
            message: 'Table cell intersects another cell.',
          });
        }
      } else if (irr.kind === 'column-rows') {
        issues.push({
          rule: 'TableRowRegularity', severity: 'error', clause, element,
          message: `Columns 1 and ${irr.column + 1} span a different number of rows in `
            + 'the table, or within a row grouping formed by THead, TBody or TFoot.',
        });
      } else if (irr.span === undefined) {
        issues.push({
          rule: 'TableColumnRegularity', severity: 'error', clause, element,
          message: `Table rows 1 and ${irr.row + 1} span a different number of columns.`,
        });
      } else {
        issues.push({
          rule: 'TableColumnCount', severity: 'error', clause, element,
          message: `Table rows 1 and ${irr.row + 1} span a different number of columns `
            + `(${grid.columnCount} and ${irr.span} respectively).`,
        });
      }
      // An irregular table is not asked about headers.
      //
      // **Note, measured, and it covers NOTHING:** this `continue` is a
      // redundant defence — `headerConnectivity`'s own gate 1 returns
      // `undefined` for a grid carrying an irregularity, so deleting this line
      // reddens not one case. Kept because it states the rule where a reader
      // of THIS function will look for it, and because it saves the walk.
      // `structgrid.test.ts` holds the rule; breaking either alone proves
      // nothing.
      continue;
    }

    const bad = headerConnectivity(grid, cells);
    if (bad === undefined) continue;
    const el = at(bad.cell) ?? element;
    if (bad.unknown.length === 0) {
      issues.push({
        rule: 'TableHeaderConnectivity', severity: 'error', clause, element: el,
        message: 'TD has no Headers attribute, and its headers cannot be determined '
          + 'algorithmically.',
      });
    } else {
      issues.push({
        rule: 'TableHeaderUndefined', severity: 'error', clause, element: el,
        message: `TD references undefined header(s) ${bad.unknown.join(', ')}, and its `
          + 'headers cannot be determined algorithmically.',
      });
    }
  }
  return issues;
};

const RULES: Rule[] = [
  markedRule, documentTitleRule, displayDocTitleRule, suspectsRule,
  structureRule, headingNestingRule, untaggedContentRule,
  // Part 2 only. APPENDED, so the part-1 report order is byte-identical.
  identificationRule, structParentRule, structureNamespaceRule,
  roleMapChainRule, documentElementRule, metadataRule,
  // q7hc.4.1 — ISO 14289-2 8.2.5, part 2 only. APPENDED, so part-1 order holds.
  tociRefRule, headingHRule, noteProhibitedRule, rubySequenceRule,
  warichuSequenceRule, captionPositionRule, mathMlParentRule, listItemContentRule,
  feNoteRefRule, feNoteTypeRule, listNumberingRule, linkRules, tableRules,
  // q7hc.4.2 — ISO 14289-2 8.9 and 8.10, part 2 only. APPENDED, so part-1
  // order holds.
  ...ANNOT_RULES,
  // q7hc.4.3 — ISO 14289-2 8.4.5, part 2 only. APPENDED, so part-1 order holds.
  ...FONT_RULES,
  // q7hc.4.4 — ISO 14289-2 8.4.3, 8.4.4 and 8.6, part 2 only. APPENDED.
  ...TEXT_RULES,
  ...DOC_RULES,
];

/** Depth-first pre-order over the structure tree. */
function walkTree(tree: StructTreeRoot): WalkedNode[] {
  const out: WalkedNode[] = [];
  const visit = (el: StructElement, parent: StructElement | null): void => {
    out.push({ element: el, parentType: parent === null ? null : parent.StandardType, parent });
    for (const child of el.Children) visit(child, el);
  };
  for (const top of tree.Children) visit(top, null);
  return out;
}

/** `PDStructElem.isPassThroughTag` — the three types whose children stand in
 *  their own place. */
const PASS_THROUGH = new Set(['NonStruct', 'Div', 'Part']);

/** `GFPDStructTreeNode.getStructuralSignificanceChildren` — children with every
 *  pass-through element spliced away, RECURSIVELY.
 *
 *  **Invariant:** every 8.2.5 rule that reads "children" reads them this way,
 *  and `Part` is the surprising member — it is a grouping element rather than a
 *  wrapper, so a first reading treats it as opaque. Left opaque, a table whose
 *  rows sit under a `Part` has ZERO rows and is reported regular by default,
 *  which is a silent false negative. */
function significantChildren(el: StructElement): StructElement[] {
  const out: StructElement[] = [];
  for (const kid of el.Children) {
    if (PASS_THROUGH.has(kid.StandardType)) out.push(...significantChildren(kid));
    else out.push(kid);
  }
  return out;
}

/** The standard types of `significantChildren`, in order. */
function childTypes(el: StructElement): string[] {
  return significantChildren(el).map((c) => c.StandardType);
}

/** True when an element directly owns marked content (contributes glyphs). */
function isTextBearing(el: StructElement): boolean {
  return el.ContentItems.some((c) => c.kind === 'mcid');
}

const ILLUSTRATION = new Set(['Figure', 'Formula', 'Form']);
const TR_PARENTS = new Set(['Table', 'THead', 'TBody', 'TFoot']);

/** Heading level 1..6 for /H1../H6, else 0. */
function headingLevel(standardType: string): number {
  const m = /^H([1-6])$/.exec(standardType);
  return m ? Number(m[1]) : 0;
}
