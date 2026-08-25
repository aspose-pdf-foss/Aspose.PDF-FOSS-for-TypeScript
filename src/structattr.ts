import type { Document } from './document.js';
import type { StructTreeRoot } from './struct.js';
import {
  PdfObject, PdfDict, isDict, isArray, isName, isString, name,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

export type RGB = [number, number, number];
/** A single value, or one-per-edge [top, right, bottom, left]. */
export type Edged<T> = T | [T, T, T, T];

// ---- value decoders (PdfObject -> JS | undefined) ----
function decNum(doc: Document, o: PdfObject): number | undefined {
  const v = doc.resolve(o);
  return typeof v === 'number' ? v : undefined;
}
function decName(doc: Document, o: PdfObject): string | undefined {
  const v = doc.resolve(o);
  return isName(v) ? v.name : undefined;
}
function decStr(doc: Document, o: PdfObject): string | undefined {
  const v = doc.resolve(o);
  return isString(v) ? decodePdfText(v.bytes) : undefined;
}
function decStrList(doc: Document, o: PdfObject): string[] | undefined {
  const v = doc.resolve(o);
  if (!isArray(v)) return undefined;
  const out: string[] = [];
  for (const e of v) { const s = doc.resolve(e); if (isString(s)) out.push(decodePdfText(s.bytes)); }
  return out;
}
function decEnum(values: readonly string[]) {
  return (doc: Document, o: PdfObject): string | undefined => {
    const n = decName(doc, o);
    return n !== undefined && values.includes(n) ? n : undefined;
  };
}

// ---- value encoders (JS -> PdfObject) ----
function encNum(v: number): PdfObject { return v; }
function encName(v: string): PdfObject { return name(v); }
function encStr(v: string): PdfObject { return { kind: 'string', bytes: encodePdfText(v) }; }
function encStrList(v: string[]): PdfObject { return v.map((s) => ({ kind: 'string', bytes: encodePdfText(s) })); }

// ---- Layout codecs ----
function decRgb(doc: Document, o: PdfObject): RGB | undefined {
  const v = doc.resolve(o);
  if (!isArray(v) || v.length !== 3) return undefined;
  const n = v.map((x) => doc.resolve(x));
  return n.every((x) => typeof x === 'number') ? [n[0] as number, n[1] as number, n[2] as number] : undefined;
}
function decBBox(doc: Document, o: PdfObject): [number, number, number, number] | undefined {
  const v = doc.resolve(o);
  if (!isArray(v) || v.length !== 4) return undefined;
  const n = v.map((x) => doc.resolve(x));
  return n.every((x) => typeof x === 'number')
    ? [n[0] as number, n[1] as number, n[2] as number, n[3] as number] : undefined;
}
function decEdgedNum(doc: Document, o: PdfObject): number | [number, number, number, number] | undefined {
  const v = doc.resolve(o);
  if (typeof v === 'number') return v;
  if (isArray(v) && v.length === 4) {
    const n = v.map((x) => doc.resolve(x));
    if (n.every((x) => typeof x === 'number'))
      return [n[0] as number, n[1] as number, n[2] as number, n[3] as number];
  }
  return undefined;
}
function decEdgedRgb(doc: Document, o: PdfObject): RGB | [RGB, RGB, RGB, RGB] | undefined {
  const v = doc.resolve(o);
  if (isArray(v) && v.length === 4 && v.every((e) => isArray(doc.resolve(e)))) {
    const edges = v.map((e) => decRgb(doc, e));
    if (edges.every((e) => e !== undefined)) return edges as [RGB, RGB, RGB, RGB];
  }
  return decRgb(doc, o);
}
function decEdgedName(values: readonly string[]) {
  return (doc: Document, o: PdfObject): string | string[] | undefined => {
    const v = doc.resolve(o);
    if (isName(v)) return values.includes(v.name) ? v.name : undefined;
    if (isArray(v) && v.length === 4) {
      const ns = v.map((e) => decName(doc, e));
      if (ns.every((x) => x !== undefined && values.includes(x))) return ns as string[];
    }
    return undefined;
  };
}
function decNumOrName(values: readonly string[]) {
  return (doc: Document, o: PdfObject): number | string | undefined => {
    const v = doc.resolve(o);
    if (typeof v === 'number') return v;
    if (isName(v) && values.includes(v.name)) return v.name;
    return undefined;
  };
}
function decNumList(doc: Document, o: PdfObject): number | number[] | undefined {
  const v = doc.resolve(o);
  if (typeof v === 'number') return v;
  if (isArray(v)) {
    return v.map((x) => doc.resolve(x)).filter((x): x is number => typeof x === 'number');
  }
  return undefined;
}

function encRgb(v: RGB): PdfObject { return [v[0], v[1], v[2]]; }
function encBBox(v: [number, number, number, number]): PdfObject { return [v[0], v[1], v[2], v[3]]; }
function encNumOrArray(v: number | number[]): PdfObject { return Array.isArray(v) ? v.slice() : v; }
function encEdgedRgb(v: RGB | RGB[]): PdfObject {
  return Array.isArray(v[0]) ? (v as RGB[]).map((c) => [c[0], c[1], c[2]]) : [...(v as RGB)];
}
function encEdgedName(v: string | string[]): PdfObject {
  return Array.isArray(v) ? v.map((s) => name(s)) : name(v);
}
function encNumOrName(v: number | string): PdfObject {
  return typeof v === 'number' ? v : name(v);
}

/** One field: its PDF key plus a decode/encode pair. */
export interface Field {
  key: string;
  dec: (doc: Document, o: PdfObject) => unknown;
  enc: (v: any) => PdfObject;
}

const SCOPES = ['Row', 'Column', 'Both'] as const;

export interface TableAttributes {
  rowSpan?: number;
  colSpan?: number;
  headers?: string[];
  scope?: 'Row' | 'Column' | 'Both';
  summary?: string;
}

const TABLE_FIELDS: Record<string, Field> = {
  rowSpan: { key: 'RowSpan', dec: decNum, enc: encNum },
  colSpan: { key: 'ColSpan', dec: decNum, enc: encNum },
  headers: { key: 'Headers', dec: decStrList, enc: encStrList },
  scope: { key: 'Scope', dec: decEnum(SCOPES), enc: encName },
  summary: { key: 'Summary', dec: decStr, enc: encStr },
};

// ---- owner collection + precedence ----
function ownerOf(doc: Document, d: PdfDict): string | undefined {
  const o = doc.resolve(d.get('O'));
  return isName(o) ? o.name : undefined;
}
/** Normalize an /A or ClassMap value into a list of attribute dicts (resolving,
 *  skipping integer revision numbers and non-dicts). */
function attrObjects(doc: Document, v: PdfObject | undefined): PdfDict[] {
  if (v === undefined) return [];
  const resolved = doc.resolve(v);
  const arr = isArray(resolved) ? resolved : [v];
  const out: PdfDict[] = [];
  for (const e of arr) { const d = doc.resolve(e); if (isDict(d)) out.push(d); }
  return out;
}
/** Normalize a /C value into a list of class-name strings. */
function classNames(doc: Document, v: PdfObject | undefined): string[] {
  if (v === undefined) return [];
  const resolved = doc.resolve(v);
  const arr = isArray(resolved) ? resolved : [v];
  const out: string[] = [];
  for (const e of arr) { const n = doc.resolve(e); if (isName(n)) out.push(n.name); }
  return out;
}
/** Candidate attribute dicts for `owner`, in precedence order: /A entries first
 *  (array order), then /C classes resolved through the root's /ClassMap. */
export function collectOwnerDicts(
  doc: Document, root: StructTreeRoot, elemDict: PdfDict, owner: string,
): PdfDict[] {
  const out: PdfDict[] = [];
  for (const d of attrObjects(doc, elemDict.get('A'))) if (ownerOf(doc, d) === owner) out.push(d);
  const classMap = doc.resolve(root.Dict.get('ClassMap')); // live (cached root.ClassMap may be stale after writes)
  if (isDict(classMap)) {
    for (const cls of classNames(doc, elemDict.get('C'))) {
      for (const d of attrObjects(doc, classMap.get(cls))) if (ownerOf(doc, d) === owner) out.push(d);
    }
  }
  return out;
}
/** First occurrence of `key` across the ordered dict list. */
export function readAttr(dicts: PdfDict[], key: string): PdfObject | undefined {
  for (const d of dicts) if (d.has(key)) return d.get(key);
  return undefined;
}

/** Decode all known fields of `fields` from the owner's dict list, or undefined
 *  when the list is empty. */
function readOwner<T>(
  doc: Document, root: StructTreeRoot, elemDict: PdfDict, owner: string, fields: Record<string, Field>,
): T | undefined {
  const dicts = collectOwnerDicts(doc, root, elemDict, owner);
  if (dicts.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, f] of Object.entries(fields)) {
    const raw = readAttr(dicts, f.key);
    if (raw === undefined) continue;
    const v = f.dec(doc, raw);
    if (v !== undefined) out[field] = v;
  }
  return out as T;
}

/** The element's own /A dict for `owner` (normalizing /A to an array, creating
 *  the dict if absent). */
export function ownerDictForWrite(doc: Document, elemDict: PdfDict, owner: string): PdfDict {
  const raw = elemDict.get('A');
  const resolved = doc.resolve(raw);
  let arr: PdfObject[];
  if (raw === undefined) { arr = []; elemDict.set('A', arr); }
  else if (isArray(resolved)) { arr = resolved; }
  else { arr = [raw]; elemDict.set('A', arr); }
  for (const e of arr) { const d = doc.resolve(e); if (isDict(d) && ownerOf(doc, d) === owner) return d; }
  const dict: PdfDict = new Map<string, PdfObject>([['O', name(owner)]]);
  arr.push(dict);
  return dict;
}

/** Merge a typed partial into the element's /A dict for `owner`: set each present
 *  field (undefined deletes the key). */
function writeOwner(
  doc: Document, elemDict: PdfDict, owner: string, fields: Record<string, Field>, attrs: Record<string, unknown>,
): void {
  const dict = ownerDictForWrite(doc, elemDict, owner);
  for (const [field, f] of Object.entries(fields)) {
    if (!(field in attrs)) continue;
    const v = attrs[field];
    if (v === undefined) dict.delete(f.key);
    else dict.set(f.key, f.enc(v));
  }
  doc.markModified();
}

// ---- Table owner ----
export function readTable(doc: Document, root: StructTreeRoot, elemDict: PdfDict): TableAttributes | undefined {
  const t = readOwner<TableAttributes>(doc, root, elemDict, 'Table', TABLE_FIELDS);
  if (t === undefined) return undefined;
  if (t.rowSpan === undefined) t.rowSpan = 1;
  if (t.colSpan === undefined) t.colSpan = 1;
  return t;
}
export function writeTable(doc: Document, elemDict: PdfDict, attrs: Partial<TableAttributes>): void {
  writeOwner(doc, elemDict, 'Table', TABLE_FIELDS, attrs as Record<string, unknown>);
}

// ---- List owner ----
const LIST_NUMBERING = [
  'None', 'Disc', 'Circle', 'Square',
  'Decimal', 'UpperRoman', 'LowerRoman', 'UpperAlpha', 'LowerAlpha',
] as const;

export interface ListAttributes {
  listNumbering?:
    | 'None' | 'Disc' | 'Circle' | 'Square'
    | 'Decimal' | 'UpperRoman' | 'LowerRoman' | 'UpperAlpha' | 'LowerAlpha';
}

const LIST_FIELDS: Record<string, Field> = {
  listNumbering: { key: 'ListNumbering', dec: decEnum(LIST_NUMBERING), enc: encName },
};

export function readList(doc: Document, root: StructTreeRoot, elemDict: PdfDict): ListAttributes | undefined {
  return readOwner<ListAttributes>(doc, root, elemDict, 'List', LIST_FIELDS);
}
export function writeList(doc: Document, elemDict: PdfDict, attrs: Partial<ListAttributes>): void {
  writeOwner(doc, elemDict, 'List', LIST_FIELDS, attrs as Record<string, unknown>);
}

// ---- Layout owner ----
export type BorderStyle =
  | 'None' | 'Hidden' | 'Dotted' | 'Dashed' | 'Solid'
  | 'Double' | 'Groove' | 'Ridge' | 'Inset' | 'Outset';

const BORDER_STYLES = [
  'None', 'Hidden', 'Dotted', 'Dashed', 'Solid', 'Double', 'Groove', 'Ridge', 'Inset', 'Outset',
] as const;

export interface LayoutAttributes {
  placement?: 'Block' | 'Inline' | 'Before' | 'Start' | 'End';
  writingMode?: 'LrTb' | 'RlTb' | 'TbRl';
  backgroundColor?: RGB;
  borderColor?: Edged<RGB>;
  borderStyle?: Edged<BorderStyle>;
  borderThickness?: Edged<number>;
  color?: RGB;
  padding?: Edged<number>;
  spaceBefore?: number;
  spaceAfter?: number;
  startIndent?: number;
  endIndent?: number;
  textIndent?: number;
  textAlign?: 'Start' | 'Center' | 'End' | 'Justify';
  bbox?: [number, number, number, number];
  width?: number | 'Auto';
  height?: number | 'Auto';
  blockAlign?: 'Before' | 'Middle' | 'After' | 'Justify';
  inlineAlign?: 'Start' | 'Center' | 'End';
  tBorderStyle?: Edged<BorderStyle>;
  tPadding?: Edged<number>;
  lineHeight?: number | 'Normal' | 'Auto';
  baselineShift?: number;
  textDecorationType?: 'None' | 'Underline' | 'Overline' | 'LineThrough';
  textDecorationColor?: RGB;
  textDecorationThickness?: number;
  columnCount?: number;
  columnGap?: number | number[];
  columnWidths?: number | number[];
  glyphOrientationVertical?: 'Auto' | number;
  rubyAlign?: 'Start' | 'Center' | 'End' | 'Justify' | 'Distribute';
  rubyPosition?: 'Before' | 'After' | 'Warichu' | 'Inline';
}

const LAYOUT_FIELDS: Record<string, Field> = {
  placement: { key: 'Placement', dec: decEnum(['Block', 'Inline', 'Before', 'Start', 'End']), enc: encName },
  writingMode: { key: 'WritingMode', dec: decEnum(['LrTb', 'RlTb', 'TbRl']), enc: encName },
  backgroundColor: { key: 'BackgroundColor', dec: decRgb, enc: encRgb },
  borderColor: { key: 'BorderColor', dec: decEdgedRgb, enc: encEdgedRgb },
  borderStyle: { key: 'BorderStyle', dec: decEdgedName(BORDER_STYLES), enc: encEdgedName },
  borderThickness: { key: 'BorderThickness', dec: decEdgedNum, enc: encNumOrArray },
  color: { key: 'Color', dec: decRgb, enc: encRgb },
  padding: { key: 'Padding', dec: decEdgedNum, enc: encNumOrArray },
  spaceBefore: { key: 'SpaceBefore', dec: decNum, enc: encNum },
  spaceAfter: { key: 'SpaceAfter', dec: decNum, enc: encNum },
  startIndent: { key: 'StartIndent', dec: decNum, enc: encNum },
  endIndent: { key: 'EndIndent', dec: decNum, enc: encNum },
  textIndent: { key: 'TextIndent', dec: decNum, enc: encNum },
  textAlign: { key: 'TextAlign', dec: decEnum(['Start', 'Center', 'End', 'Justify']), enc: encName },
  bbox: { key: 'BBox', dec: decBBox, enc: encBBox },
  width: { key: 'Width', dec: decNumOrName(['Auto']), enc: encNumOrName },
  height: { key: 'Height', dec: decNumOrName(['Auto']), enc: encNumOrName },
  blockAlign: { key: 'BlockAlign', dec: decEnum(['Before', 'Middle', 'After', 'Justify']), enc: encName },
  inlineAlign: { key: 'InlineAlign', dec: decEnum(['Start', 'Center', 'End']), enc: encName },
  tBorderStyle: { key: 'TBorderStyle', dec: decEdgedName(BORDER_STYLES), enc: encEdgedName },
  tPadding: { key: 'TPadding', dec: decEdgedNum, enc: encNumOrArray },
  lineHeight: { key: 'LineHeight', dec: decNumOrName(['Normal', 'Auto']), enc: encNumOrName },
  baselineShift: { key: 'BaselineShift', dec: decNum, enc: encNum },
  textDecorationType: {
    key: 'TextDecorationType', dec: decEnum(['None', 'Underline', 'Overline', 'LineThrough']), enc: encName,
  },
  textDecorationColor: { key: 'TextDecorationColor', dec: decRgb, enc: encRgb },
  textDecorationThickness: { key: 'TextDecorationThickness', dec: decNum, enc: encNum },
  columnCount: { key: 'ColumnCount', dec: decNum, enc: encNum },
  columnGap: { key: 'ColumnGap', dec: decNumList, enc: encNumOrArray },
  columnWidths: { key: 'ColumnWidths', dec: decNumList, enc: encNumOrArray },
  glyphOrientationVertical: { key: 'GlyphOrientationVertical', dec: decNumOrName(['Auto']), enc: encNumOrName },
  rubyAlign: {
    key: 'RubyAlign', dec: decEnum(['Start', 'Center', 'End', 'Justify', 'Distribute']), enc: encName,
  },
  rubyPosition: { key: 'RubyPosition', dec: decEnum(['Before', 'After', 'Warichu', 'Inline']), enc: encName },
};

export function readLayout(doc: Document, root: StructTreeRoot, elemDict: PdfDict): LayoutAttributes | undefined {
  return readOwner<LayoutAttributes>(doc, root, elemDict, 'Layout', LAYOUT_FIELDS);
}
export function writeLayout(doc: Document, elemDict: PdfDict, attrs: Partial<LayoutAttributes>): void {
  writeOwner(doc, elemDict, 'Layout', LAYOUT_FIELDS, attrs as Record<string, unknown>);
}
