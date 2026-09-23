import type { Document } from './document.js';
import { PdfDict, isDict, isArray, isName, isRef } from './types.js';
import { PdfParseError } from './errors.js';
import { Page } from './page.js';

/** Page tree resolved to a flat list, with the object numbers needed to rewrite it. */
export interface PageTree {
  /** One Page per leaf, in document order. */
  pages: Page[];
  /** Object number backing each page (parallel to `pages`); 0 if the leaf is inline. */
  pageObjNums: number[];
  /** Object number of the root /Pages node, or undefined when /Pages is inline. */
  rootPagesNum: number | undefined;
}

/** Walk the page tree and return one Page per leaf (live dict), in document order. */
export function buildPages(doc: Document): PageTree {
  const catalog = doc.catalog();
  const pagesRef = catalog.get('Pages');
  const pagesRoot = doc.resolve(pagesRef);
  if (!isDict(pagesRoot)) throw new PdfParseError('catalog /Pages is not a dict');
  const rootPagesNum = isRef(pagesRef) ? pagesRef.num : undefined;
  const leaves: { dict: PdfDict; objNum: number }[] = [];
  walk(doc, pagesRoot, rootPagesNum, new Set(), leaves, 1, { visits: 0 });
  return {
    pages: leaves.map((leaf, i) => new Page(doc, leaf.dict, i + 1)),
    pageObjNums: leaves.map((leaf) => leaf.objNum),
    rootPagesNum,
  };
}

/** The walk treats the page tree as a DAG (`1lr9`). A node reached a second
 *  time is walked again, so a page listed twice becomes two `Page` entries over
 *  ONE dictionary and `pageObjNums` repeats its number — Open reads, it does not
 *  repair; `doc.Validate()` reports the sharing and `doc.Repair()` splits it.
 *  It used to keep one walk-wide `seen` set and throw 'cycle in page tree',
 *  which left the file unopenable.
 *
 *  Only a node that is its own ANCESTOR is a cycle, and its back edge is
 *  skipped rather than thrown on, for the same reason — it is damage the page
 *  list can be built around, and Validate names it.
 *
 *  Walking a shared node again is what makes a FAN-OUT possible — `/Kids
 *  [B B]`, B `/Kids [C C]`, … reaches 2^n pages from n tiny objects — so every
 *  node VISITED counts against `maxObjects`, the bound on rows as they are
 *  produced. The walk-wide refusal this replaces happened to block that; the
 *  bound is what blocks it now. */
function walk(
  doc: Document, node: PdfDict, objNum: number | undefined,
  ancestors: Set<PdfDict>, out: { dict: PdfDict; objNum: number }[], depth: number,
  count: { visits: number },
): void {
  doc.loadLimits.enforce('maxObjects', ++count.visits, 'page tree');
  const type = node.get('Type');
  const kids = doc.resolve(node.get('Kids'));
  if (isName(type) && type.name === 'Page') {
    out.push({ dict: node, objNum: objNum ?? 0 });
    return;
  }
  if (isArray(kids)) {
    // Counted on INTERMEDIATE nodes only, so the bound means "levels of /Pages"
    // and a page tree of depth N is admitted at a limit of N. Every node is its
    // own flat object, so nothing but this walk can see the depth — and the
    // Document constructor runs it, which makes an unbounded one an Open crash.
    doc.loadLimits.enforce('maxNestingDepth', depth, 'page tree');
    ancestors.add(node);
    for (const kid of kids) {
      const childNum = isRef(kid) ? kid.num : undefined;
      const child = doc.resolve(kid);
      if (isDict(child) && !ancestors.has(child))
        walk(doc, child, childNum, ancestors, out, depth + 1, count);
    }
    ancestors.delete(node);
    return;
  }
  // Leaf without explicit /Type and no kids: treat as page.
  out.push({ dict: node, objNum: objNum ?? 0 });
}
