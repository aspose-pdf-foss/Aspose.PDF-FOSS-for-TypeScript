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
  walk(doc, pagesRoot, rootPagesNum, new Set(), leaves);
  return {
    pages: leaves.map((leaf, i) => new Page(doc, leaf.dict, i + 1)),
    pageObjNums: leaves.map((leaf) => leaf.objNum),
    rootPagesNum,
  };
}

function walk(
  doc: Document, node: PdfDict, objNum: number | undefined,
  seen: Set<PdfDict>, out: { dict: PdfDict; objNum: number }[],
): void {
  if (seen.has(node)) throw new PdfParseError('cycle in page tree');
  seen.add(node);
  const type = node.get('Type');
  const kids = doc.resolve(node.get('Kids'));
  if (isName(type) && type.name === 'Page') {
    out.push({ dict: node, objNum: objNum ?? 0 });
    return;
  }
  if (isArray(kids)) {
    for (const kid of kids) {
      const childNum = isRef(kid) ? kid.num : undefined;
      const child = doc.resolve(kid);
      if (isDict(child)) walk(doc, child, childNum, seen, out);
    }
    return;
  }
  // Leaf without explicit /Type and no kids: treat as page.
  out.push({ dict: node, objNum: objNum ?? 0 });
}
