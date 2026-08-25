import type { Document } from './document.js';
import type { TextBlock, TextFragment } from './text.js';

/** Round a font size to the nearest half point so near-identical sizes bucket together. */
export function roundSize(s: number): number { return Math.round(s * 2) / 2; }

/** The size bucket with the most characters among `fragments`. */
export function dominantFragmentSize(fragments: TextFragment[]): number {
  const chars = new Map<number, number>();
  for (const f of fragments) {
    const sz = roundSize(f.fontSize);
    chars.set(sz, (chars.get(sz) ?? 0) + f.text.length);
  }
  let best = 0, bestC = -1;
  for (const [sz, c] of chars) if (c > bestC) { bestC = c; best = sz; }
  return best;
}

/** The size bucket with the most characters among a block's fragments. */
export function dominantSize(block: TextBlock): number {
  return dominantFragmentSize(block.lines.flatMap((l) => l.fragments));
}

/** Heading-size → level map (largest = H1, capped at H6), from every fragment
 *  across the document: the size with the most characters is body text; larger
 *  distinct sizes become headings. */
export function headingRanks(doc: Document): Map<number, number> {
  const chars = new Map<number, number>();
  for (const page of doc.Pages) for (const block of page.GetStructuredText()) {
    for (const line of block.lines) for (const f of line.fragments) {
      const sz = roundSize(f.fontSize);
      chars.set(sz, (chars.get(sz) ?? 0) + f.text.length);
    }
  }
  let bodySize = 0, bodyChars = -1;
  for (const [sz, c] of chars) if (c > bodyChars) { bodyChars = c; bodySize = sz; }
  const larger = [...chars.keys()].filter((s) => s > bodySize + 0.5).sort((a, b) => b - a);
  const ranks = new Map<number, number>();
  larger.forEach((s, i) => ranks.set(s, Math.min(i + 1, 6)));
  return ranks;
}
