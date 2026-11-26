import type { CompareTextOptions, TextChange, TextComparison, TextSpan } from './compare.js';
import type { Document } from './document.js';
import { rectToQuad } from './annotation.js';
import type { Rect } from './text.js';

export interface ComparisonMarkupOptions {
  /** Mark deletions on the source or insertions on the destination (default). */
  side?: 'source' | 'destination';
  compare?: CompareTextOptions;
}

export interface ComparisonMarkupResult {
  document: Document;
  comparison: TextComparison;
}

interface Anchor { page: number; rect: Rect }

/** One pass in reading order. Leading changes wait for the first equal span.
 * Subsequent carets can immediately use the preceding equal span. */
export function markComparison(out: Document, comparison: TextComparison, side: 'source' | 'destination'): void {
  const spansOf = (change: TextChange) => side === 'source' ? change.old : change.new;
  const label = (change: TextChange) => change.op === 'delete' ? `Deleted: ${change.oldText}` : `Inserted: ${change.newText}`;
  const insertion: [number, number, number] = [0.45, 0.85, 0.45];
  const deletion: [number, number, number] = [0.88, 0.22, 0.22];

  function caret(change: TextChange, anchor: Anchor, after: boolean): void {
    const page = out.Pages[anchor.page - 1];
    const [left, bottom, right, top] = anchor.rect;
    const [xmin, , xmax] = page.CropBox;
    const width = Math.min((top - bottom) / 2, xmax - xmin);
    if (width <= 0) return;
    const x = Math.max(xmin, Math.min(after ? right : left - width, xmax - width));
    page.AddCaret({ rect: [x, bottom, x + width, top], contents: label(change),
      color: change.op === 'insert' ? insertion : deletion });
  }

  function markSpan(change: TextChange, span: TextSpan): void {
    if (!span.quads.length) return;
    const page = out.Pages[span.page - 1];
    const quads = span.quads.flatMap(rectToQuad);
    if (change.op === 'delete') page.AddStrikeOut({ quads, color: deletion, contents: `Deleted: ${span.text}` });
    else page.AddHighlight({ quads, color: insertion, contents: `Inserted: ${span.text}` });
  }

  function markBlock(changes: TextChange[]): void {
    const leading: TextChange[] = [];
    let previous: Anchor | undefined;
    for (const change of changes) {
      const spans = spansOf(change);
      if (change.op === 'equal') {
        for (const span of spans) {
          if (!span.quads.length) continue;
          for (const pending of leading) caret(pending, { page: span.page, rect: span.quads[0] }, false);
          leading.length = 0;
          previous = { page: span.page, rect: span.quads[span.quads.length - 1] };
        }
      } else if ((side === 'source' && change.op === 'delete') || (side === 'destination' && change.op === 'insert')) {
        for (const span of spans) markSpan(change, span);
      } else if (previous) caret(change, previous, true);
      else leading.push(change);
    }
  }

  if (comparison.pages) {
    for (const pair of comparison.pages) markBlock(pair.changes);
  } else markBlock(comparison.changes);
}
