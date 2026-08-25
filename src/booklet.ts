// Saddle-stitch booklet imposition: the pure model (issue 1gg0.2). Padding, the
// sheet ordering permutation, and cell geometry including creep. This module
// imports nothing and touches no PDF objects, so the arithmetic that is silently
// wrong when reversed can be tested without building a file. Sheet assembly
// lives in document.ts (Document.Booklet), beside NUp.

/** Options for {@link Document.Booklet}. */
export interface BookletOptions {
  /** Binding edge. 'right' mirrors every side for an RTL book. Default 'left'. */
  binding?: 'left' | 'right';
  /** Output sheet size [w, h]; default = [2*W + 2*margin + gutter, H + 2*margin]
   *  from the first source page's CropBox. */
  pageSize?: [number, number];
  /** Outer margin in points around both cells. Default 0. */
  margin?: number;
  /** Spacing in points between the two cells (across the spine). Default 0. */
  gutter?: number;
  /** Creep compensation in points per nesting level; inner sheets' content
   *  shifts toward the spine and sheet 0 never moves. Default 0. */
  creep?: number;
  /** Sheets per folded signature. Integer >= 1. Default: the whole book is one
   *  signature — folding 40 nested sheets is not physical, so a long book is
   *  bound as several signatures, each folded and stapled separately. */
  sheetsPerSignature?: number;
  /** Pad the book so every signature holds exactly `sheetsPerSignature` sheets.
   *  Default false: the last signature is short, as a real bindery would run it.
   *  Requires `sheetsPerSignature`. */
  padSignatures?: boolean;
}

/** @internal One printed side of a folded sheet. */
export interface BookletSide {
  /** Nesting level WITHIN its signature: 0 = that signature's outermost sheet.
   *  Drives creep, which restarts per signature because each one folds on its
   *  own — a globally increasing level would shift the last sheet of a long book
   *  by many times the intended creep. */
  sheet: number;
  /** 0-based signature index; always 0 without `sheetsPerSignature`. */
  signature: number;
  /** 1-based source page number in the left cell, or null for a pad blank. */
  left: number | null;
  /** 1-based source page number in the right cell, or null for a pad blank. */
  right: number | null;
}

/** @internal The ordering options — the subset of {@link BookletOptions} that
 *  decides which page lands on which sheet, as opposed to sheet geometry. */
export type BookletOrderOptions =
  Pick<BookletOptions, 'binding' | 'sheetsPerSignature' | 'padSignatures'>;

/** @internal Resolved sheet geometry, shared by every side. */
export interface BookletMetrics {
  sheetW: number;
  sheetH: number;
  cellW: number;
  cellH: number;
  margin: number;
  gutter: number;
  creep: number;
}

/** @internal The printed sides of a saddle-stitch booklet of `pageCount` pages,
 *  in duplex print order (sheet 0 front, sheet 0 back, sheet 1 front, …).
 *
 *  Pages are padded to a multiple of 4. A padded page number beyond `pageCount`
 *  is a blank and comes back as `null` rather than a number, so the caller
 *  places nothing there — as NUp leaves the unused cells of a partial last sheet
 *  empty. Sheet s carries front `[M-2s | 2s+1]` and back `[2s+2 | M-2s-1]`;
 *  'right' binding swaps the two cells on every side.
 *
 *  With `sheetsPerSignature` the padded list is split into chunks of
 *  4 * sheetsPerSignature pages and the same formula runs over each chunk at an
 *  offset, so each signature folds on its own; `padSignatures` first pads the
 *  book so every chunk is full. */
export function bookletSides(
  pageCount: number, opts: BookletOrderOptions = {},
): BookletSide[] {
  if (pageCount <= 0) return [];
  const binding = opts.binding ?? 'left';
  let n = Math.ceil(pageCount / 4) * 4;
  // Without sheetsPerSignature the whole book is one signature, so perSig = n
  // and the loop below runs exactly once with offset 0 — today's formula, not a
  // separate branch.
  const perSig = opts.sheetsPerSignature !== undefined ? 4 * opts.sheetsPerSignature : n;
  if (opts.padSignatures) n = Math.ceil(n / perSig) * perSig;
  const cell = (p: number): number | null => (p <= pageCount ? p : null);
  const sides: BookletSide[] = [];
  for (let signature = 0, offset = 0; offset < n; signature++, offset += perSig) {
    // Both n and perSig are multiples of 4, so a short last chunk is still a
    // whole number of sheets.
    const m = Math.min(perSig, n - offset);
    for (let s = 0; s < m / 4; s++) {
      const pairs: [number, number][] = [
        [offset + m - 2 * s, offset + 2 * s + 1],     // front
        [offset + 2 * s + 2, offset + m - 2 * s - 1], // back
      ];
      for (const [l, r] of pairs) {
        const [left, right] = binding === 'right' ? [r, l] : [l, r];
        sides.push({ sheet: s, signature, left: cell(left), right: cell(right) });
      }
    }
  }
  return sides;
}

/** @internal The two cell rects `[x0, y0, x1, y1]` of a sheet at nesting level
 *  `sheet`, with creep applied.
 *
 *  **Creep direction.** Nested sheets protrude at the fore edge when folded, and
 *  the stack is then trimmed flush, so INNER pages lose more fore-edge paper
 *  than outer ones. The compensation therefore moves inner sheets' content
 *  TOWARD the spine — left cell `+d`, right cell `-d`. Reversing this looks
 *  identical on screen and is wrong on paper, which is why the sign has its own
 *  test. Sheet 0 is never shifted, so `creep: 0` is byte-identical to omitting
 *  the option.
 *
 *  The offset moves the whole cell rect, not the content within a fixed cell:
 *  `placeFitted` scales-to-fit and centres inside whatever rect it is given, so
 *  the placed content translates and does not change size. */
export function bookletCells(
  m: BookletMetrics, sheet: number,
): { left: [number, number, number, number]; right: [number, number, number, number] } {
  const d = sheet * m.creep;
  const y0 = m.margin, y1 = m.margin + m.cellH;
  const leftX0 = m.margin + d;
  const rightX0 = m.margin + m.cellW + m.gutter - d;
  return {
    left: [leftX0, y0, leftX0 + m.cellW, y1],
    right: [rightX0, y0, rightX0 + m.cellW, y1],
  };
}
