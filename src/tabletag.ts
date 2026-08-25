// The /Table + /TR + /TD structure subtree behind `page.AddTable({ tagged: true })`
// (issue 7efj). Structure only: no measurement, no painting. tablerender.ts
// builds a page slice's skeleton through this and then paints into the elements
// it hands back, which is why this is its own module — mirroring tocstruct.ts,
// where threading the tree through paintRow would have blurred "where the ink
// goes".
//
// Note the direction: tablestruct.ts is table *extraction* from an existing
// tagged tree. This is authoring. The two never import each other.
import type { Document } from './document.js';
import type { StructElement } from './struct.js';
import type { CellBuilder } from './tableauthor.js';

/** Validate a table's tagging options. Throws before the caller allocates or
 *  paints anything, so a rejected call leaves the document byte-identical. */
export function validateTableTagging(
  doc: Document, opts: { tagged?: boolean; structParent?: StructElement },
): void {
  const tagged = opts.tagged ?? false;
  if (typeof tagged !== 'boolean') throw new TypeError('tagged must be a boolean');
  const sp = opts.structParent;
  if (sp === undefined) return;
  // Explicit rejection rather than implying `tagged`: an unused option must
  // never silently change output.
  if (!tagged) throw new TypeError('structParent requires tagged: true');
  if (sp.Ref === undefined)
    throw new TypeError('structParent must be a structure element with an indirect ref');
  const root = doc.GetStructTree();
  if (!root || sp.Root.Dict !== root.Dict)
    throw new TypeError('structParent belongs to a different document');
}

/** The /Scope a cell's /TH carries, or undefined when the cell is a /TD.
 *
 *  The cell's own `header` wins over the repeating-header inference in both
 *  directions: `false` is an opt-out, so a blank corner cell in a header row
 *  stays a /TD rather than becoming a header of nothing. */
export function headerScope(
  cell: CellBuilder, rowIndex: number, repeatingRows: number,
): 'Row' | 'Column' | undefined {
  const h = cell.header;
  if (h === 'row') return 'Row';
  if (h === 'column' || h === true) return 'Column';
  if (h === false) return undefined;
  return rowIndex < repeatingRows ? 'Column' : undefined;
}

export interface TableTaggerOptions {
  /** Element to append the /Table under; a /Table element is *reused* rather
   *  than nested. Default: the structure tree root. */
  structParent?: StructElement;
}

/** Builds the /Table subtree for one `AddTable` call. One tagger spans every
 *  page a table is painted onto, so an auto-paginated table is a single /Table
 *  whose /TR list runs in draw order. */
export class TableTagger {
  /** The root /Table element this tagger fills. */
  readonly table: StructElement;

  /** The /TR the next `cell` joins; undefined before the first `beginRow`. */
  private row: StructElement | undefined;

  constructor(doc: Document, opts: TableTaggerOptions = {}) {
    const parent = opts.structParent;
    // A /Table parent is continuation, not nesting: a manual-pagination loop
    // hands back the previous call's element so a three-page table is one table.
    this.table = parent !== undefined && parent.Type === 'Table'
      ? parent
      : (parent ?? doc.CreateStructTree()).Append('Table');
  }

  /** Open a /TR. Every following `cell` joins it until the next `beginRow`. */
  beginRow(): void {
    this.row = this.table.Append('TR');
  }

  /** Append this cell's /TD or /TH to the open /TR and return it.
   *
   *  `rowSpan` is the EFFECTIVE span from the occupancy grid, not
   *  `CellBuilder.rowSpan`: both of the grid's clamps are silent, and this is
   *  the one place the two values differ observably — which is why the clamp
   *  happens in the grid rather than at paint time. A tagged document is then
   *  at least self-consistent: the tag never describes rows the block does not
   *  cover. */
  cell(
    cell: CellBuilder, rowIndex: number, repeatingRows: number, rowSpan = 1,
  ): StructElement {
    if (this.row === undefined) throw new Error('cell before beginRow');
    const scope = headerScope(cell, rowIndex, repeatingRows);
    const elem = this.row.Append(scope === undefined ? 'TD' : 'TH');
    // Written only when there is something to say: readTable defaults an absent
    // ColSpan and RowSpan to 1, so an /A on every plain cell would be pure bloat.
    const attrs: { colSpan?: number; rowSpan?: number; scope?: 'Row' | 'Column' } = {};
    if (cell.colSpan > 1) attrs.colSpan = cell.colSpan;
    if (rowSpan > 1) attrs.rowSpan = rowSpan;
    if (scope !== undefined) attrs.scope = scope;
    if (attrs.colSpan !== undefined || attrs.rowSpan !== undefined || attrs.scope !== undefined)
      elem.SetTableAttributes(attrs);
    return elem;
  }

  /** Append a /Figure to `cellElem` for its image, carrying `alt` when given. */
  figure(cellElem: StructElement, alt?: string): StructElement {
    return cellElem.Append('Figure', alt !== undefined ? { alt } : undefined);
  }
}
