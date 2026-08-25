import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isString, name, ref } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

/** A logical page-label range in the /Root /PageLabels number tree. */
export interface PageLabel {
  /** 0-based page index where this range begins. */
  startIndex: number;
  /** Numbering style; `none` renders the prefix alone. */
  style?: 'decimal' | 'roman' | 'Roman' | 'alpha' | 'Alpha' | 'none';
  /** Label prefix (e.g. "A-"). */
  prefix?: string;
  /** First numeric value in the range (default 1). */
  start?: number;
}

const STYLE_FROM_S: Record<string, PageLabel['style']> = {
  D: 'decimal', r: 'roman', R: 'Roman', a: 'alpha', A: 'Alpha',
};
const S_FROM_STYLE: Record<NonNullable<PageLabel['style']>, string | undefined> = {
  decimal: 'D', roman: 'r', Roman: 'R', alpha: 'a', Alpha: 'A', none: undefined,
};

/** Flatten a number-tree node into ascending `[key, value]` pairs (honoring
 *  /Nums leaves and /Kids recursion). */
function readNumberTree(doc: Document, node: PdfObject, out: Array<[number, PdfObject]>): void {
  const n = doc.resolve(node);
  if (!isDict(n)) return;
  const nums = doc.resolve(n.get('Nums'));
  if (isArray(nums)) {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const k = doc.resolve(nums[i]);
      if (typeof k === 'number') out.push([k, nums[i + 1]]);
    }
  }
  const kids = doc.resolve(n.get('Kids'));
  if (isArray(kids)) for (const kid of kids) readNumberTree(doc, kid, out);
}

/** Parse /Root /PageLabels into ascending ranges. Leniently read. */
export function parsePageLabels(doc: Document): PageLabel[] {
  const root = doc.resolve(doc.catalog().get('PageLabels'));
  if (!isDict(root)) return [];
  const entries: Array<[number, PdfObject]> = [];
  readNumberTree(doc, root, entries);
  entries.sort((a, b) => a[0] - b[0]);
  const out: PageLabel[] = [];
  for (const [key, value] of entries) {
    const dict = doc.resolve(value);
    if (!isDict(dict)) continue;
    const label: PageLabel = { startIndex: key };
    const s = doc.resolve(dict.get('S'));
    // An absent or unrecognized /S means "prefix only" — i.e. the `none` style.
    label.style = isName(s) && STYLE_FROM_S[s.name] ? STYLE_FROM_S[s.name] : 'none';
    const p = doc.resolve(dict.get('P'));
    if (isString(p)) label.prefix = decodePdfText(p.bytes);
    const st = doc.resolve(dict.get('St'));
    if (typeof st === 'number') label.start = st;
    out.push(label);
  }
  return out;
}

/** A lowercase roman numeral for `n >= 1` (returns "" for n < 1). */
function toRoman(n: number): string {
  if (n < 1) return '';
  const table: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let s = '';
  for (const [v, sym] of table) while (n >= v) { s += sym; n -= v; }
  return s;
}

/** Spreadsheet-free alphabetic label: a..z, aa..zz, aaa.. (lowercase). */
function toAlpha(n: number): string {
  if (n < 1) return '';
  const letter = String.fromCharCode(0x61 + (n - 1) % 26);
  const count = Math.floor((n - 1) / 26) + 1;
  return letter.repeat(count);
}

/** Render the numeral portion of a label for a given style and value. */
function numeral(style: PageLabel['style'], value: number): string {
  switch (style) {
    case 'decimal': return String(value);
    case 'roman': return toRoman(value);
    case 'Roman': return toRoman(value).toUpperCase();
    case 'alpha': return toAlpha(value);
    case 'Alpha': return toAlpha(value).toUpperCase();
    default: return ''; // 'none' or unspecified
  }
}

/** Resolve a 0-based page index to its rendered label given parsed ranges.
 *  With no applicable range, falls back to the decimal page number. */
export function resolvePageLabel(labels: PageLabel[], pageIndex: number): string {
  let range: PageLabel | undefined;
  for (const l of labels) {
    if (l.startIndex <= pageIndex) range = l;
    else break; // labels are ascending
  }
  if (!range) return String(pageIndex + 1);
  const offset = pageIndex - range.startIndex;
  return (range.prefix ?? '') + numeral(range.style, (range.start ?? 1) + offset);
}

/** Build context supplied by Document: indirect-object allocation. */
export interface PageLabelBuildCtx {
  alloc(obj: PdfObject): PdfRef;
}

/** Validate `labels` (throws before any mutation), then build the /PageLabels
 *  number-tree root object and return its ref. */
export function buildPageLabels(labels: PageLabel[], ctx: PageLabelBuildCtx): PdfRef {
  const sorted = [...labels].sort((a, b) => a.startIndex - b.startIndex);
  for (const l of sorted) {
    if (!Number.isInteger(l.startIndex) || l.startIndex < 0)
      throw new RangeError(`page-label startIndex ${l.startIndex} must be a non-negative integer`);
  }
  if (sorted.length && sorted[0].startIndex !== 0)
    throw new RangeError('first page-label range must start at index 0');

  const nums: PdfObject[] = [];
  for (const l of sorted) {
    const dict: PdfDict = new Map<string, PdfObject>();
    const s = l.style ? S_FROM_STYLE[l.style] : undefined;
    if (s) dict.set('S', name(s));
    if (l.prefix !== undefined && l.prefix !== '') dict.set('P', { kind: 'string', bytes: encodePdfText(l.prefix) });
    if (l.start !== undefined) dict.set('St', l.start);
    nums.push(l.startIndex, dict);
  }
  return ctx.alloc(new Map<string, PdfObject>([['Nums', nums]]));
}
