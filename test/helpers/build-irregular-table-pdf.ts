import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';
import type { StructElement } from '../../src/struct.js';
import { ownerDictForWrite } from '../../src/structattr.js';
import { name } from '../../src/types.js';

/** One cell of a test table. */
export interface Cell {
  header?: boolean;
  rowSpan?: number;
  colSpan?: number;
  id?: string;
  scope?: 'Row' | 'Column' | 'Both';
  /** A `/Scope` OUTSIDE the enumeration, written straight into the Table
   *  attribute dict — `SetTableAttributes` is typed and cannot express one.
   *  It is the only input on which the validator's RAW scope read differs from
   *  the typed one: veraPDF counts a TH as scoped when it states ANY name, so
   *  a junk scope still satisfies the table-level gate. */
  rawScope?: string;
  headers?: string[];
}

export interface TableSpec {
  /** Rows outside any grouping. */
  rows?: Cell[][];
  /** Row groupings, each emitted as its own THead/TBody/TFoot element. */
  groups?: { type: 'THead' | 'TBody' | 'TFoot'; rows: Cell[][] }[];
  /** Wrap every row in a pass-through element of this type (NonStruct, Div or
   *  Part), to prove the walk splices it away. */
  wrapRowsIn?: string;
}

/** A tagged, titled document holding one /Table built exactly as `spec` says.
 *
 *  Spans are written VERBATIM, so an irregular spec produces an irregular table
 *  rather than being fixed up on the way in — which is the whole point: the
 *  authoring layer would place these cells legally, and the validator must see
 *  them as declared. */
export function buildStructTablePdf(spec: TableSpec): Uint8Array {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  doc.SetMetadata({ title: 'T' });
  doc.DisplayDocTitle = true;
  const root = doc.CreateStructTree();
  const table = root.Append('Document').Append('Table');

  const emitRows = (parent: StructElement, rows: Cell[][]): void => {
    const host = spec.wrapRowsIn === undefined ? parent : parent.Append(spec.wrapRowsIn);
    for (const row of rows) {
      const tr = host.Append('TR');
      for (const c of row) {
        const cell = tr.Append(c.header === true ? 'TH' : 'TD',
          c.id === undefined ? undefined : { id: c.id });
        const attrs: Record<string, unknown> = {};
        if (c.rowSpan !== undefined) attrs.rowSpan = c.rowSpan;
        if (c.colSpan !== undefined) attrs.colSpan = c.colSpan;
        if (c.scope !== undefined) attrs.scope = c.scope;
        if (c.headers !== undefined) attrs.headers = c.headers;
        if (Object.keys(attrs).length > 0) cell.SetTableAttributes(attrs);
        if (c.rawScope !== undefined) {
          const owner = ownerDictForWrite(doc, cell.Dict, 'Table');
          owner.set('Scope', name(c.rawScope));
          doc.markModified();
        }
      }
    }
  };

  emitRows(table, spec.rows ?? []);
  for (const g of spec.groups ?? []) emitRows(table.Append(g.type), g.rows);
  return doc.Save();
}
