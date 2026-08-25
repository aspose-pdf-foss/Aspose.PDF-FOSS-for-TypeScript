import type { Document } from './document.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { visitContent } from './text.js';
import { PdfDict, isDict } from './types.js';
import { ValidationReport, type ValidationIssue, type Severity } from './validation.js';

// Re-export so existing importers of these from structvalidate keep working.
export { ValidationReport };
export type { ValidationIssue, Severity };

/** Run the curated PDF/UA rule set over `doc`. `catalog` is the document catalog
 *  dict (the facade supplies it so catalog-only rules need no public accessor). */
export function validatePdfUa(doc: Document, catalog: PdfDict): ValidationReport {
  const tree = doc.GetStructTree();
  if (!tree) {
    return new ValidationReport([{
      rule: 'Tagged', severity: 'error', clause: 'ISO 14289-1 §7.1',
      message: 'Document is not tagged: no /StructTreeRoot in the catalog.',
    }]);
  }
  const issues: ValidationIssue[] = [];
  if (!doc.IsTagged) {
    issues.push({
      rule: 'Tagged', severity: 'error', clause: 'ISO 14289-1 §7.1',
      message: 'Catalog /MarkInfo /Marked is not true.',
    });
  }

  // DocumentTitle — Info /Title or XMP dc:title must be non-empty.
  const title = doc.GetMetadata().title ?? doc.GetXmp().title;
  if (!title || title.trim() === '') {
    issues.push({
      rule: 'DocumentTitle', severity: 'error', clause: 'ISO 14289-1 §7.1 (Matterhorn 06-003)',
      message: 'Document has no title (/Info /Title and XMP dc:title are both empty).',
    });
  }

  // DisplayDocTitle — /ViewerPreferences /DisplayDocTitle must be true.
  const vp = doc.resolve(catalog.get('ViewerPreferences'));
  const ddt = isDict(vp) ? doc.resolve(vp.get('DisplayDocTitle')) : undefined;
  if (ddt !== true) {
    issues.push({
      rule: 'DisplayDocTitle', severity: 'error', clause: 'ISO 14289-1 §7.1 (Matterhorn 07-001)',
      message: 'Catalog /ViewerPreferences /DisplayDocTitle is not true.',
    });
  }

  // Suspects — /MarkInfo /Suspects must not be true (warning).
  const mi = doc.resolve(catalog.get('MarkInfo'));
  if (isDict(mi) && doc.resolve(mi.get('Suspects')) === true) {
    issues.push({
      rule: 'Suspects', severity: 'warning', clause: 'Matterhorn 01-005',
      message: 'Catalog /MarkInfo /Suspects is true: tagging may be unreliable.',
    });
  }

  const nodes = walkTree(tree);
  for (const { element, parentType } of nodes) {
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

  // HeadingNesting — numbered headings must not skip a level descending.
  let prevLevel = 0;
  for (const { element } of nodes) {
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

  // UntaggedContent — page content that is neither tagged (mcid) nor artifacted.
  for (const page of doc.Pages) {
    let untagged = false;
    visitContent(doc, page, {
      glyph: (e) => { if (e.mcid === undefined && !e.artifact) untagged = true; },
      image: (e) => { if (e.mcid === undefined && !e.artifact) untagged = true; },
      path: (e) => { if (e.mcid === undefined && !e.artifact) untagged = true; },
    });
    if (untagged) {
      issues.push({
        rule: 'UntaggedContent', severity: 'warning', clause: 'Matterhorn 01-006', page,
        message: 'Page has visible content (text, image or vector) that is neither tagged nor marked as an artifact.',
      });
    }
  }

  return new ValidationReport(issues);
}

interface WalkedNode { element: StructElement; parentType: string | null; }

/** Depth-first pre-order over the structure tree. */
function walkTree(tree: StructTreeRoot): WalkedNode[] {
  const out: WalkedNode[] = [];
  const visit = (el: StructElement, parentType: string | null): void => {
    out.push({ element: el, parentType });
    for (const child of el.Children) visit(child, el.StandardType);
  };
  for (const top of tree.Children) visit(top, null);
  return out;
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
