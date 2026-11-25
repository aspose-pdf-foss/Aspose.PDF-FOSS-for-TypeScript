import type { Page } from './page.js';
import { blocksFromFragments, type ExtractOptions, type Rect, type TextBlock, type TextFragment, type TextLine } from './text.js';

export interface ParagraphReadOptions extends ExtractOptions {
  /** Join a column's last paragraph to the next column or page when the prose continues. */
  joinContinuations?: boolean;
}

export interface ParagraphContinuation {
  pageNumber: number;
  quad: Rect;
  lines: TextLine[];
}

/** Text and lines include joined segments. The page number and quad locate the first segment. */
export interface ExtractedParagraph extends TextBlock {
  pageNumber: number;
  continuations?: ParagraphContinuation[];
}

/** Split along open vertical gutters before fragments on a shared baseline are combined. */
function columns(fragments: TextFragment[], pageWidth: number): TextFragment[][] {
  const sorted = [...fragments].sort((a, b) => a.quad[0] - b.quad[0]);
  const groups: TextFragment[][] = [];
  let edge = -Infinity;
  for (const f of sorted) {
    if (!groups.length || f.quad[0] - edge > Math.max(f.fontSize, pageWidth * 0.045)) groups.push([]);
    groups[groups.length - 1].push(f);
    edge = Math.max(edge, f.quad[2]);
  }
  // Indented lines below a heading can also leave a vertical gutter. Columns
  // must occupy some common height, otherwise the fragments read top to bottom.
  const extents = groups.map(group => group.reduce(([bottom, top], f) =>
    [Math.min(bottom, f.quad[1]), Math.max(top, f.quad[3])], [Infinity, -Infinity]));
  for (let i = 1; i < extents.length; i++) {
    if (extents[i][0] > extents[i - 1][1] || extents[i - 1][0] > extents[i][1]) return [fragments];
  }
  return groups;
}

/** Retry within horizontal bands when a spanning title or footer closes a gutter. */
function pageBands(fragments: TextFragment[], width: number): TextFragment[][][] {
  const whole = columns(fragments, width);
  if (whole.length !== 1) return [whole];
  const bands: TextFragment[][] = [];
  let previous: TextFragment | undefined;
  for (const f of [...fragments].sort((a, b) => b.quad[1] - a.quad[1])) {
    if (!previous || previous.quad[1] - f.quad[1] > 2 * Math.max(previous.fontSize, f.fontSize)) bands.push([]);
    bands[bands.length - 1].push(f);
    previous = f;
  }
  const divided = bands.map(b => columns(b, width));
  return divided.some(band => band.length > 1) ? divided : [whole];
}

function isFurniture(p: TextBlock, box: number[]): boolean {
  if (p.lines.length !== 1 || p.text.trim().split(/\s+/u).length > 3) return false;
  const band = (box[3] - box[1]) / 8;
  return p.quad[1] >= box[3] - band || p.quad[3] <= box[1] + band;
}

function typeSize(lines: TextLine[]): number {
  let size = 0;
  for (const line of lines) {
    for (const f of line.fragments) if (f.text.trim()) size = Math.max(size, f.fontSize);
  }
  return size;
}

function continues(a: ExtractedParagraph, b: TextBlock): boolean {
  const lines = a.continuations?.at(-1)?.lines ?? a.lines;
  const size = typeSize(lines), nextSize = typeSize(b.lines);
  if (!size || !nextSize || Math.max(size, nextSize) > 1.15 * Math.min(size, nextSize)) return false;
  const last = lines[lines.length - 1];
  if (lines.some(l => last.quad[2] < l.quad[2] - 2 * size)) return false;
  if (b.lines.length > 1 && b.lines[0].quad[0] > b.lines[1].quad[0] + nextSize / 2) return false;
  return /^\p{Ll}/u.test(b.text.trimStart()) || !/[.!?:;…"”’)»]$/u.test(a.text.trimEnd());
}

function appendContinuation(carrier: ExtractedParagraph, part: ExtractedParagraph): void {
  const tail = carrier.text.trimEnd();
  carrier.text = tail + (tail.endsWith('-') ? '' : ' ') + part.text.trimStart();
  for (const line of part.lines) carrier.lines.push(line);
  (carrier.continuations ??= []).push({ pageNumber: part.pageNumber, quad: part.quad, lines: part.lines });
}

/** @internal */
export function readParagraphs(pages: Page[], options?: ParagraphReadOptions): ExtractedParagraph[] {
  const result: ExtractedParagraph[] = [];
  let carrier: ExtractedParagraph | undefined;
  for (const page of pages) {
    const box = page.CropBox;
    const fragments = page.GetTextFragments(options);
    if (!fragments.some(f => f.text.trim())) {
      carrier = undefined;
      continue;
    }
    const bands = pageBands(fragments, box[2] - box[0]);
    let firstBodyOnPage = true;
    for (const band of bands) {
      for (const [index, group] of band.entries()) {
        let canJoin = firstBodyOnPage || index > 0;
        for (const block of blocksFromFragments(group)) {
          if (!block.text.trim()) continue;
          const part = { ...block, pageNumber: page.Number };
          if (options?.joinContinuations && !isFurniture(part, box)) {
            firstBodyOnPage = false;
            if (canJoin && carrier && continues(carrier, part)) {
              appendContinuation(carrier, part);
              canJoin = false;
              continue;
            }
            canJoin = false;
            carrier = part;
          }
          result.push(part);
        }
      }
    }
  }
  return result;
}
