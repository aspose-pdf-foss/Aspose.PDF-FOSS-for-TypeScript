import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ValidationIssue } from './validation.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef } from './types.js';
import { rethrowLimit } from './errors.js';

/** US Letter — the box `Page.MediaBox` reports for a page that states none, so
 *  a repaired file agrees with what this library has been rendering. */
export const LETTER_MEDIABOX: readonly number[] = [0, 0, 612, 792];

interface Walk {
  doc: Document;
  fix: boolean;
  issues: ValidationIssue[];
  /** Every node reached so far, for PageTreeShared. */
  seen: Set<PdfDict>;
  /** Pages under each finished intermediate node, so a shared node still
   *  counts toward its second parent in validate mode. */
  counts: Map<PdfDict, number>;
  /** Live Page handle per page dict, for ValidationIssue.page. */
  pageOf: Map<PdfDict, Page>;
}

/** The page-tree structure check behind `doc.Validate()` (`fix` false) and
 *  `doc.Repair()` (`fix` true). ONE walk for both, so a checker and a fixer
 *  cannot disagree about which nodes are pages.
 *
 *  It reads the RAW `/Kids` graph from `/Root`, never `doc.Pages`, so damage
 *  done through a page's live `Dict` after Open is visible. It follows `/Kids`
 *  ONLY: `/Parent`, an annotation's `/P` and an outline's `/Prev` are
 *  back-references the format requires, not cycles. A reference to an absent
 *  object is null (7.3.10) and is not itself a failure.
 *
 *  Leaf versus intermediate is decided exactly as `pagetree.ts`'s `buildPages`
 *  decides it, so this and `doc.Pages` agree about which nodes are pages. */
export function checkPageTree(doc: Document, fix: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let catalog: PdfDict;
  try {
    catalog = doc.catalog();
  } catch (caught) {
    rethrowLimit(caught);
    issues.push(issue('CatalogInvalid', '/Root does not resolve to a dictionary'));
    return issues;
  }
  if (!isNamed(doc.resolve(catalog.get('Type')), 'Catalog')) {
    issues.push(issue('CatalogInvalid', 'the /Root dictionary is not /Type /Catalog'));
    return issues;
  }
  const rootRaw = catalog.get('Pages');
  const root = doc.resolve(rootRaw);
  if (!isDict(root) || !isNamed(doc.resolve(root.get('Type')), 'Pages')) {
    issues.push(issue('CatalogInvalid', 'the catalog /Pages is not a /Type /Pages dictionary',
      isRef(rootRaw) ? rootRaw : undefined));
    return issues;
  }
  const w: Walk = {
    doc, fix, issues, seen: new Set(), counts: new Map(),
    pageOf: new Map(doc.Pages.map((p) => [p.Dict, p])),
  };
  visit(w, root, isRef(rootRaw) ? rootRaw : undefined, new Set(), false, 1);
  return issues;
}

/** Visit an intermediate node; returns the number of pages found under it. */
function visit(
  w: Walk, node: PdfDict, nodeRef: PdfRef | undefined,
  ancestors: Set<PdfDict>, boxAbove: boolean, depth: number,
): number {
  // Same bound, same unit, as buildPages: levels of intermediate nodes.
  w.doc.loadLimits.enforce('maxNestingDepth', depth, 'page tree');
  w.seen.add(node);
  ancestors.add(node);
  const boxHere = boxAbove || node.has('MediaBox');
  const kidsVal = w.doc.resolve(node.get('Kids'));
  const kids: PdfObject[] = isArray(kidsVal) ? kidsVal : [];
  const kept: PdfObject[] = [];
  let changed = false;
  let pages = 0;

  for (const raw of kids) {
    let child = w.doc.resolve(raw);
    // A dead kid is legal null: it contributes no page, and only the /Count
    // check below can notice it.
    if (!isDict(child)) { kept.push(raw); continue; }
    let childRaw: PdfObject = raw;

    if (w.seen.has(child)) {
      const cyclic = ancestors.has(child);
      w.issues.push(issue('PageTreeShared', cyclic
        ? 'a page-tree node lists one of its own ancestors in /Kids'
        : 'a page-tree node is listed more than once', refOf(raw), w.pageOf.get(child)));
      if (!w.fix) {
        pages += cyclic ? 0 : (w.counts.get(child) ?? 1);
        kept.push(raw);
        continue;
      }
      changed = true;
      // Copying an ancestor would never terminate: drop the back edge.
      if (cyclic) continue;
      const copy: PdfDict = new Map(child);
      childRaw = isRef(raw) ? w.doc.allocObject(copy) : copy;
      child = copy;
    }

    // A kid of an INLINE node cannot name it: there is no reference to write.
    if (nodeRef !== undefined && w.doc.resolve(child.get('Parent')) !== node) {
      w.issues.push(issue('PageParentMismatch',
        'a page-tree node\'s /Parent is not the node that lists it',
        refOf(childRaw), w.pageOf.get(child)));
      if (w.fix) child.set('Parent', nodeRef);
    }

    if (isLeaf(w.doc, child)) {
      w.seen.add(child);
      pages += 1;
      if (!boxHere && !child.has('MediaBox')) {
        w.issues.push(issue('PageMediaBoxMissing',
          'a page has no /MediaBox on itself or on any node above it',
          refOf(childRaw), w.pageOf.get(child)));
        if (w.fix) child.set('MediaBox', [...LETTER_MEDIABOX]);
      }
    } else {
      pages += visit(w, child, isRef(childRaw) ? childRaw : undefined, ancestors, boxHere, depth + 1);
    }
    kept.push(childRaw);
  }
  ancestors.delete(node);

  if (w.doc.resolve(node.get('Count')) !== pages) {
    w.issues.push(issue('PageCountMismatch',
      `/Count does not agree with the ${pages} page(s) found under this node`, nodeRef));
    if (w.fix) {
      node.set('Count', pages);
      // Only where /Count is being corrected: a null kid is legal, so a node
      // Validate passes keeps it and a clean document stays byte-identical.
      const live = kept.filter((k) => isDict(w.doc.resolve(k)));
      if (live.length !== kept.length) { kept.length = 0; kept.push(...live); changed = true; }
    }
  }
  if (w.fix && changed) node.set('Kids', kept);
  w.counts.set(node, pages);
  return pages;
}

/** buildPages' rule, verbatim: /Type /Page is a leaf; else a /Kids array makes
 *  an intermediate node; else a leaf. */
function isLeaf(doc: Document, d: PdfDict): boolean {
  const type = d.get('Type');
  if (isName(type) && type.name === 'Page') return true;
  return !isArray(doc.resolve(d.get('Kids')));
}

function isNamed(v: PdfObject, n: string): boolean {
  return isName(v) && v.name === n;
}

function refOf(o: PdfObject): PdfRef | undefined {
  return isRef(o) ? o : undefined;
}

function issue(rule: string, message: string, object?: PdfRef, page?: Page): ValidationIssue {
  const out: ValidationIssue = { rule, severity: 'error', message };
  if (object) out.object = object;
  if (page) out.page = page;
  return out;
}
