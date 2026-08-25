// Grid arithmetic shared by both table detectors: turning cut lines into cells
// with spans, and the cell-level text and geometry helpers.
//
// A LEAF. table.ts (ruled) and tablestream.ts (whitespace) both import it, so it
// must import neither — that is what keeps tablestream.ts from having to take
// buildCells as an argument the way docxtable.ts takes its paragraph builder.
import type { Rect, TableCell } from './tablemodel.js';
import type { TextFragment } from './text.js';

/** A cell's text: its fragments assembled into lines by baseline, each line
 *  left-to-right with a space inserted across a gap wider than a quarter em. */
export function cellText(frags: TextFragment[]): string {
  if (!frags.length) return '';
  const sorted = [...frags].sort((a, b) => (b.quad[1] - a.quad[1]) || (a.quad[0] - b.quad[0]));
  const lines: TextFragment[][] = [];
  let bucket: TextFragment[] = [];
  let y = sorted[0].quad[1];
  for (const f of sorted) {
    if (bucket.length && Math.abs(f.quad[1] - y) > Math.max(2, 0.5 * f.fontSize)) { lines.push(bucket); bucket = []; }
    if (!bucket.length) y = f.quad[1];
    bucket.push(f);
  }
  if (bucket.length) lines.push(bucket);
  return lines.map((ln) => {
    ln.sort((a, b) => a.quad[0] - b.quad[0]);
    let s = '', prevEnd: number | undefined;
    for (const f of ln) {
      if (prevEnd !== undefined && f.quad[0] - prevEnd > 0.25 * f.fontSize && !s.endsWith(' ') && !f.text.startsWith(' ')) s += ' ';
      s += f.text; prevEnd = f.quad[2];
    }
    return s.trim();
  }).join('\n');
}

export const centroid = (q: Rect): [number, number] => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
export const contains = (q: Rect, x: number, y: number): boolean => x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3];

/** The bounding box of a row's cells. */
export function rowBbox(cells: TableCell[]): Rect {
  return [
    Math.min(...cells.map((c) => c.quad[0])), Math.min(...cells.map((c) => c.quad[1])),
    Math.max(...cells.map((c) => c.quad[2])), Math.max(...cells.map((c) => c.quad[3])),
  ];
}

export function buildCells(
  xcuts: number[], ycuts: number[], vSep: boolean[][], hSep: boolean[][],
): { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect }[] {
  const R = ycuts.length - 1, C = xcuts.length - 1;
  const out: { row: number; col: number; rowSpan: number; colSpan: number; quad: Rect }[] = [];
  if (R < 1 || C < 1) return out;
  const consumed: boolean[][] = Array.from({ length: R }, () => new Array(C).fill(false));

  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (consumed[r][c]) continue;
      // Grow colSpan across missing vertical separators on the top row r.
      let colSpan = 1;
      while (c + colSpan < C && !consumed[r][c + colSpan] && vSep[r]?.[c + colSpan - 1] === false)
        colSpan++;
      // Grow rowSpan down while the horizontal separator below is absent for every column in the span.
      let rowSpan = 1;
      while (r + rowSpan < R) {
        let open = true;
        for (let k = c; k < c + colSpan; k++)
          if (hSep[k]?.[r + rowSpan - 1] !== false || consumed[r + rowSpan][k]) { open = false; break; }
        if (!open) break;
        rowSpan++;
      }
      for (let rr = r; rr < r + rowSpan; rr++)
        for (let cc = c; cc < c + colSpan; cc++) consumed[rr][cc] = true;
      const x0 = xcuts[c], x1 = xcuts[c + colSpan];
      const yTop = ycuts[r], yBot = ycuts[r + rowSpan];   // yTop > yBot (descending)
      out.push({ row: r, col: c, rowSpan, colSpan, quad: [x0, yBot, x1, yTop] });
    }
  }
  return out;
}
