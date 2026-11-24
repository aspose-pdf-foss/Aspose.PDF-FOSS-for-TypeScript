import { parseMarkerText, type Marker } from './docinfer.js';
import type { Table } from './tablemodel.js';

/** A whitespace grid may be the alignment between each list label and its
 *  text. Yield it to list inference only with evidence from every row. */
export function isListTable(table: Table): boolean {
  if (table.colCount !== 2 || table.rowCount < 2) return false;
  let previous: Marker | undefined;
  for (const row of table.rows) {
    // Tagged and rotated tables have no measured borders. A ruled or shaded
    // grid supplies stronger evidence than punctuation in its first column.
    if (row.cells.length !== 2 || row.cells.some(cell =>
      cell.colSpan !== 1 || cell.rowSpan !== 1 || cell.borders === undefined ||
      Object.keys(cell.borders).length > 0 || cell.shading !== undefined)) return false;
    const label = row.cells[0].text.trim();
    const parsed = parseMarkerText(label);
    if (!parsed || parsed.length !== label.length || !row.cells[1].text.trim()) return false;
    const { marker } = parsed;
    if (previous && (marker.ordered !== previous.ordered ||
      typeof marker.ordinal !== typeof previous.ordinal)) return false;
    if (previous?.ordinal !== undefined && marker.ordinal !== previous.ordinal + 1) return false;
    previous = marker;
  }
  return true;
}
