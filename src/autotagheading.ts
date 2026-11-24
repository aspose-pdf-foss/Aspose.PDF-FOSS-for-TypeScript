import type { AutoTagOptions } from './autotag.js';
import type { Document } from './document.js';
import { decodePdfText } from './metadata.js';
import { resolvePageDest } from './outline.js';
import type { Page } from './page.js';
import type { TextBlock } from './text.js';
import { dominantSize, headingRanks } from './textrank.js';
import { isDict, isString, type PdfDict, type PdfObject } from './types.js';

type HeadingLevel = (page: Page, block: TextBlock, pageBlocks?: readonly TextBlock[]) => number | undefined;

function titleKey(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function outlineHeadings(doc: Document): HeadingLevel {
  const outlines = doc.resolve(doc.catalog().get('Outlines'));
  if (!isDict(outlines)) return () => undefined;
  const targets = new Map<number, Map<string, number | undefined>>();
  const seen = new Set<PdfDict>();
  const pageNumbers = new Map<PdfDict, number>();
  for (const page of doc.Pages) {
    if (!pageNumbers.has(page.Dict)) pageNumbers.set(page.Dict, page.Number);
  }
  function pageOf(value: PdfObject): number | undefined {
    const dict = doc.resolve(value);
    return isDict(dict) ? pageNumbers.get(dict) : undefined;
  }
  // resolvePageDest needs the original /Dest or /A dictionary. A decoded name
  // has already lost the byte spelling that selects its name-tree entry.
  function visit(first: PdfObject | undefined, depth: number): void {
    let item = doc.resolve(first);
    while (isDict(item) && !seen.has(item)) {
      seen.add(item);
      doc.loadLimits.enforce('maxNestingDepth', depth, 'outline');
      const title = doc.resolve(item.get('Title'));
      const key = isString(title) ? titleKey(decodePdfText(title.bytes)) : '';
      if (key) {
        const dest = resolvePageDest(doc, item, pageOf);
        if (dest) {
          const pageTargets = targets.get(dest.page) ?? new Map<string, number | undefined>();
          pageTargets.set(key, pageTargets.has(key) ? undefined : Math.min(depth, 6));
          targets.set(dest.page, pageTargets);
        }
      }
      visit(item.get('First'), depth + 1);
      item = doc.resolve(item.get('Next'));
    }
  }
  visit(outlines.get('First'), 1);

  // Titles repeated on a page do not identify a single block. Discard both
  // occurrences, including when one is a running header or inside a table.
  let currentPage: Page | undefined;
  const matches = new Map<string, TextBlock['quad'] | undefined>();
  return (page, block, pageBlocks) => {
    const titles = targets.get(page.Number);
    if (!titles || block.lines.length > 2) return undefined;
    if (page !== currentPage) {
      matches.clear();
      for (const candidate of pageBlocks ?? page.GetStructuredText()) {
        const key = titleKey(candidate.text);
        if (titles.has(key)) matches.set(key, matches.has(key) ? undefined : candidate.quad);
      }
      currentPage = page;
    }
    const key = titleKey(block.text);
    // List segmentation can produce a second block spelling the title. Only
    // the original, uniquely matched block owns this bookmark.
    const quad = matches.get(key);
    return quad?.every((coord, i) => coord === block.quad[i]) ? titles.get(key) : undefined;
  };
}

/** Prepare and validate the selected strategy before AutoTag edits the PDF. */
export function prepareHeadings(doc: Document, opts: AutoTagOptions): HeadingLevel {
  const { headingStrategy = 'fontSize', headingThresholds } = opts;
  if (headingStrategy === 'thresholds') {
    if (!Array.isArray(headingThresholds) || !headingThresholds.length || headingThresholds.length > 6)
      throw new TypeError('headingThresholds must contain one to six descending minimum font sizes');
    const thresholds = [...headingThresholds];
    for (let i = 0; i < thresholds.length; i++) {
      const size = thresholds[i];
      if (!Number.isFinite(size) || size <= 0 || (i > 0 && size >= thresholds[i - 1]))
        throw new RangeError('headingThresholds must be strictly decreasing positive finite sizes');
    }
    return (_page, block) => {
      if (block.lines.length > 2) return undefined;
      // Compare actual points at an explicit cutoff. Ranking rounds to 0.5pt.
      const size = dominantSize(block, size => size);
      const index = thresholds.findIndex(minimum => size >= minimum);
      return index < 0 ? undefined : index + 1;
    };
  }
  if (headingThresholds !== undefined)
    throw new TypeError("headingThresholds requires headingStrategy 'thresholds'");
  if (headingStrategy === 'outline') return outlineHeadings(doc);
  if (headingStrategy !== 'fontSize')
    throw new TypeError("headingStrategy must be 'fontSize', 'outline' or 'thresholds'");
  const ranks = headingRanks(doc);
  return (_page, block) => block.lines.length <= 2 ? ranks.get(dominantSize(block)) : undefined;
}
