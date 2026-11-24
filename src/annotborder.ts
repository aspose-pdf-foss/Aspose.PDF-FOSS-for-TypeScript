import type { Document } from './document.js';
import type { FieldBorderStyle } from './fieldstyle.js';
import { isArray, isDict, isName, name, type PdfDict, type PdfObject } from './types.js';

/** Drawing styles with a generated appearance. Other /BS styles can be read
 *  and retained on imported annotations. */
export interface DrawingBorderOptions {
  borderStyle?: 'solid' | 'dashed';
  /** Dash lengths in points for the dashed style. Defaults to 3 on, 3 off. */
  dashPattern?: number[];
}

function validPattern(p: unknown[]): p is number[] {
  return p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    && p.some(v => typeof v === 'number' && v > 0);
}

function copyPattern(p: number[] | undefined): number[] | undefined {
  if (p === undefined) return undefined;
  if (!Array.isArray(p)) throw new TypeError('DashPattern must be an array');
  const copy = [...p];
  if (!copy.length) return undefined;
  if (!validPattern(copy)) throw new TypeError('DashPattern needs non-negative finite lengths with at least one positive length');
  return copy;
}

function styleName(style: 'solid' | 'dashed'): PdfObject {
  if (style !== 'solid' && style !== 'dashed') throw new TypeError('BorderStyle must be solid or dashed');
  return name(style === 'dashed' ? 'D' : 'S');
}

export function drawingBorder(width: number, options: DrawingBorderOptions): PdfDict {
  const bs: PdfDict = new Map<string, PdfObject>([['Type', name('Border')], ['W', width]]);
  if (options.borderStyle !== undefined) bs.set('S', styleName(options.borderStyle));
  const dash = copyPattern(options.dashPattern);
  if (dash) bs.set('D', dash);
  return bs;
}

/** A /BS dictionary supersedes the entire legacy /Border array. */
function borderEntry(doc: Document, dict: PdfDict, key: string, index: number): PdfObject {
  const bs = doc.resolve(dict.get('BS'));
  if (isDict(bs)) return doc.resolve(bs.get(key));
  const border = doc.resolve(dict.get('Border'));
  return isArray(border) ? doc.resolve(border[index]) : null;
}

export function readBorderWidth(doc: Document, dict: PdfDict, defaultWidth = 1): number {
  const w = borderEntry(doc, dict, 'W', 2);
  return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : defaultWidth;
}

export function readDashPattern(doc: Document, dict: PdfDict): number[] | undefined {
  const raw = borderEntry(doc, dict, 'D', 3);
  if (!isArray(raw)) return undefined;
  const p = Array.from(raw, v => doc.resolve(v));
  return validPattern(p) ? p : undefined;
}

export function readBorderStyle(doc: Document, dict: PdfDict): FieldBorderStyle {
  const bs = doc.resolve(dict.get('BS'));
  if (!isDict(bs)) return readDashPattern(doc, dict) ? 'dashed' : 'solid';
  const s = doc.resolve(bs.get('S'));
  switch (isName(s) && s.name) {
    case 'D': return 'dashed';
    case 'B': return 'beveled';
    case 'I': return 'inset';
    case 'U': return 'underline';
    default: return 'solid';
  }
}

/** Copy on write: imported /BS dictionaries can be indirect and shared.
 *  When introducing /BS, migrate the legacy width and dash it will supersede. */
function editableBorder(doc: Document, dict: PdfDict): PdfDict {
  const bs = doc.resolve(dict.get('BS'));
  if (isDict(bs)) return new Map(bs);
  const dashPattern = readDashPattern(doc, dict);
  return drawingBorder(readBorderWidth(doc, dict), { borderStyle: dashPattern ? 'dashed' : undefined, dashPattern });
}

export function setBorderWidth(doc: Document, dict: PdfDict, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('BorderWidth must be a non-negative finite number');
  dict.set('BS', editableBorder(doc, dict).set('W', value));
}

export function setBorderStyle(doc: Document, dict: PdfDict, value: 'solid' | 'dashed'): void {
  dict.set('BS', editableBorder(doc, dict).set('S', styleName(value)));
}

export function setDashPattern(doc: Document, dict: PdfDict, value: number[] | undefined): void {
  const dash = copyPattern(value);
  const bs = editableBorder(doc, dict);
  if (dash) bs.set('D', dash);
  else bs.delete('D');
  dict.set('BS', bs);
}
