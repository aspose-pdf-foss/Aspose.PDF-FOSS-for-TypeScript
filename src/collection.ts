import { PdfDict, PdfObject, name, isArray, isDict, isName, isString } from './types.js';
import { encodePdfText, decodePdfText } from './metadata.js';
import type { Document } from './document.js';

/** How a viewer presents the portfolio. */
export type CollectionView = 'details' | 'tile' | 'hidden';

/** A schema column: built-in fields derive from the filespec; custom fields
 *  (string/date/number) read their value from each file's /CI. */
export type CollectionFieldType =
  | 'filename' | 'description' | 'size' | 'compressedSize' | 'creationDate' | 'modDate'
  | 'string' | 'date' | 'number';

export interface CollectionFieldDef {
  /** Schema key (and /CI key for custom fields). */
  name: string;
  type: CollectionFieldType;
  /** Column header (/N). */
  displayName: string;
  /** Column order (/O). */
  order?: number;
  /** Column visible (/V). Default true. */
  visible?: boolean;
  /** Value editable in a viewer (/E). Default false. */
  editable?: boolean;
}

export interface CollectionSettings {
  fields: CollectionFieldDef[];
  /** Default 'details'. */
  view?: CollectionView;
  /** Field name to sort on. */
  sortBy?: string;
  /** Default true. */
  sortAscending?: boolean;
  /** Name of the file shown first (/D). */
  initialFile?: string;
}

const TYPE_TO_SUBTYPE: Record<CollectionFieldType, string> = {
  filename: 'F', description: 'Desc', size: 'Size', compressedSize: 'CompressedSize',
  creationDate: 'CreationDate', modDate: 'ModDate', string: 'S', date: 'D', number: 'N',
};
const SUBTYPE_TO_TYPE: Record<string, CollectionFieldType> = {
  F: 'filename', Desc: 'description', Size: 'size', CompressedSize: 'compressedSize',
  CreationDate: 'creationDate', ModDate: 'modDate', S: 'string', D: 'date', N: 'number',
};
const VIEW_TO_NAME: Record<CollectionView, string> = { details: 'D', tile: 'T', hidden: 'H' };
const NAME_TO_VIEW: Record<string, CollectionView> = { D: 'details', T: 'tile', H: 'hidden' };

const pdfStr = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** Build the /Collection dict as one nested direct dict. Validates first so a
 *  bad `settings` throws before any document mutation. */
export function buildCollection(settings: CollectionSettings): PdfDict {
  const known = new Set<string>();
  for (const f of settings.fields) {
    if (typeof f.name !== 'string' || f.name === '') throw new TypeError('collection field name must be a non-empty string');
    if (typeof f.displayName !== 'string' || f.displayName === '') throw new TypeError('collection field displayName must be a non-empty string');
    if (!(f.type in TYPE_TO_SUBTYPE)) throw new TypeError(`unknown collection field type: ${f.type}`);
    known.add(f.name);
  }
  if (settings.sortBy !== undefined && !known.has(settings.sortBy)) throw new RangeError(`sortBy references unknown field: ${settings.sortBy}`);
  if (settings.initialFile !== undefined && settings.initialFile === '') throw new RangeError('initialFile must be a non-empty string');

  const col: PdfDict = new Map<string, PdfObject>();
  col.set('Type', name('Collection'));
  col.set('View', name(VIEW_TO_NAME[settings.view ?? 'details']));

  const schema: PdfDict = new Map<string, PdfObject>();
  schema.set('Type', name('CollectionSchema'));
  for (const f of settings.fields) {
    const field: PdfDict = new Map<string, PdfObject>();
    field.set('Type', name('CollectionField'));
    field.set('Subtype', name(TYPE_TO_SUBTYPE[f.type]));
    field.set('N', pdfStr(f.displayName));
    if (f.order !== undefined) field.set('O', f.order);
    field.set('V', f.visible ?? true);
    field.set('E', f.editable ?? false);
    schema.set(f.name, field);
  }
  col.set('Schema', schema);

  if (settings.sortBy !== undefined) {
    const sort: PdfDict = new Map<string, PdfObject>();
    sort.set('Type', name('CollectionSort'));
    sort.set('S', name(settings.sortBy));
    sort.set('A', settings.sortAscending ?? true);
    col.set('Sort', sort);
  }
  if (settings.initialFile !== undefined) col.set('D', pdfStr(settings.initialFile));
  return col;
}

/** Read /Root /Collection into CollectionSettings, or undefined when absent. */
export function readCollection(doc: Document): CollectionSettings | undefined {
  const col = doc.resolve(doc.catalog().get('Collection'));
  if (!isDict(col)) return undefined;

  const viewName = col.get('View');
  const view: CollectionView = isName(viewName) && NAME_TO_VIEW[viewName.name] ? NAME_TO_VIEW[viewName.name] : 'details';

  const fields: CollectionFieldDef[] = [];
  const schema = doc.resolve(col.get('Schema'));
  if (isDict(schema)) {
    for (const [key, raw] of schema) {
      if (key === 'Type') continue;
      const fd = doc.resolve(raw);
      if (!isDict(fd)) continue;
      const sub = fd.get('Subtype');
      const type = isName(sub) && SUBTYPE_TO_TYPE[sub.name] ? SUBTYPE_TO_TYPE[sub.name] : 'string';
      const n = fd.get('N');
      const def: CollectionFieldDef = { name: key, type, displayName: isString(n) ? decodePdfText(n.bytes) : key };
      const o = doc.resolve(fd.get('O'));
      if (typeof o === 'number') def.order = o;
      const v = fd.get('V'); if (typeof v === 'boolean') def.visible = v;
      const e = fd.get('E'); if (typeof e === 'boolean') def.editable = e;
      fields.push(def);
    }
  }
  fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const settings: CollectionSettings = { fields, view };
  const sort = doc.resolve(col.get('Sort'));
  if (isDict(sort)) {
    const s = sort.get('S');
    if (isName(s)) settings.sortBy = s.name;
    else if (isArray(s)) { const s0 = doc.resolve(s[0]); if (isName(s0)) settings.sortBy = s0.name; }
    const a = sort.get('A');
    settings.sortAscending = typeof a === 'boolean' ? a : (isArray(a) && typeof a[0] === 'boolean' ? a[0] : true);
  }
  const d = col.get('D');
  if (isString(d)) settings.initialFile = decodePdfText(d.bytes);
  return settings;
}
