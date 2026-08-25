import type { Document } from './document.js';
import { PdfDict, PdfObject, isDict, isName, name } from './types.js';
import { num } from './pagecontent.js';
import { checkNums } from './annotation.js';
import type { StdFont } from './metrics.js';

/** Acrobat's conventional /DR /Font resource keys for the Standard-14 faces.
 *  These are the names its /DA strings expect; da.ts already reads them. */
export const DR_KEY: Record<StdFont, string> = {
  'Helvetica': 'Helv', 'Helvetica-Bold': 'HeBo',
  'Helvetica-Oblique': 'HeOb', 'Helvetica-BoldOblique': 'HeBO',
  'Courier': 'Cour', 'Courier-Bold': 'CoBo',
  'Courier-Oblique': 'CoOb', 'Courier-BoldOblique': 'CoBO',
  'Times-Roman': 'TiRo', 'Times-Bold': 'TiBo',
  'Times-Italic': 'TiIt', 'Times-BoldItalic': 'TiBI',
  'Symbol': 'Symb', 'ZapfDingbats': 'ZaDb',
};

/** A PdfString carrying a latin1/ASCII byte string (/DA and friends, which are
 *  read back with a latin1 decoder in da.ts — never UTF-16). */
export function pdfLatin(s: string): PdfObject {
  return { kind: 'string', bytes: new TextEncoder().encode(s) };
}

/** Register `std` in the AcroForm /DR /Font and return its resource key.
 *  Reuses any key already bound to that face, so repeated calls never
 *  duplicate a font. When the conventional key is held by a *different* face,
 *  takes a suffixed key instead of retargeting it — silently repointing /Helv
 *  would change how every existing field in the document renders. */
export function ensureDRFont(doc: Document, acro: PdfDict, std: StdFont): string {
  let dr = doc.resolve(acro.get('DR'));
  if (!isDict(dr)) { dr = new Map<string, PdfObject>(); acro.set('DR', dr); }
  let fonts = doc.resolve((dr as PdfDict).get('Font'));
  if (!isDict(fonts)) { fonts = new Map<string, PdfObject>(); (dr as PdfDict).set('Font', fonts); }
  const table = fonts as PdfDict;

  for (const k of table.keys()) {
    const fd = doc.resolve(table.get(k));
    if (!isDict(fd)) continue;
    const bf = doc.resolve((fd as PdfDict).get('BaseFont'));
    if (isName(bf) && bf.name === std) return k;
  }

  const base = DR_KEY[std];
  let key = base;
  for (let i = 2; table.has(key); i++) key = `${base}${i}`;
  const fontDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type1')],
    ['BaseFont', name(std)],
  ]);
  // Symbol and ZapfDingbats carry their own built-in encodings; forcing
  // WinAnsi on them would mis-map every glyph.
  if (std !== 'Symbol' && std !== 'ZapfDingbats')
    fontDict.set('Encoding', name('WinAnsiEncoding'));
  table.set(key, doc.allocObject(fontDict));
  return key;
}

/** A /DA string: font resource key, size (0 = auto-size to the box), and an
 *  RGB fill colour. `rg` rather than `g` even for grey, so there is one form
 *  to write and one to read back. */
export function fieldDA(key: string, size: number, color: [number, number, number]): string {
  const [r, g, b] = color;
  return `/${key} ${num(size)} Tf ${num(r)} ${num(g)} ${num(b)} rg`;
}

/** How a widget's border is drawn (/BS /S). */
export type FieldBorderStyle =
  'solid' | 'dashed' | 'beveled' | 'inset' | 'underline';

/** Every supported style, for validation and exhaustive tests. */
export const BORDER_STYLES: readonly FieldBorderStyle[] =
  ['solid', 'dashed', 'beveled', 'inset', 'underline'];

/** The /BS /S name for each style (PDF 32000-1 table 166). */
export const BS_S: Record<FieldBorderStyle, string> = {
  solid: 'S', dashed: 'D', beveled: 'B', inset: 'I', underline: 'U',
};

/** /MK + /BS: what a widget's box looks like. Every key is optional and an
 *  absent one is left as it is, which is what makes the same type usable for
 *  creation and for restyling an existing field. */
export interface WidgetStyle {
  /** /MK /BG fill, RGB 0..1. `null` paints nothing (an empty /BG array). */
  backgroundColor?: [number, number, number] | null;
  /** /MK /BC stroke, RGB 0..1. `null` paints nothing. */
  borderColor?: [number, number, number] | null;
  /** /BS /W in points. Default 1 whenever /BS is written. */
  borderWidth?: number;
  /** /BS /S. Default 'solid'. */
  borderStyle?: FieldBorderStyle;
  /** /BS /D dash lengths in points. Only with 'dashed'; default [3]. */
  dashPattern?: number[];
  /** /MK /R — a counter-clockwise quarter turn of the field's contents inside
   *  its unchanged /Rect. 0 leaves it upright. */
  rotate?: 0 | 90 | 180 | 270;
}

/** WidgetStyle plus the /DA text half. */
export interface FieldStyle extends WidgetStyle {
  /** Standard-14 face for the field's /DA. */
  font?: StdFont;
  /** /DA font size; 0 auto-sizes to the box. */
  fontSize?: number;
  /** /DA text colour, RGB 0..1. */
  textColor?: [number, number, number];
}

/** A validated WidgetStyle. `undefined` means "leave the key alone"; `null`
 *  means "explicitly nothing" and becomes an empty PDF array. */
export interface NormalizedStyle {
  bg?: number[] | null;
  bc?: number[] | null;
  width?: number;
  style?: FieldBorderStyle;
  dash?: number[];
  rotate?: 0 | 90 | 180 | 270;
}

/** The quarter turns /MK /R may take. */
const ROTATIONS: readonly number[] = [0, 90, 180, 270];

/** An RGB triple validated to 0..1, passed through `null` and `undefined`. */
export function checkColor(
  key: string, c: [number, number, number] | null | undefined,
): number[] | null | undefined {
  if (c === undefined) return undefined;
  if (c === null) return null;
  const v = checkNums(key, c, 3);
  if (v.some((x) => x < 0 || x > 1))
    throw new TypeError(`${key} components must be in 0..1`);
  return v;
}

/** Reject a `font` that is not one of the fourteen. TypeScript already narrows
 *  it, but a JavaScript caller reaches ensureDRFont with it and would otherwise
 *  get `/undefined` as the /DA resource key. */
export function checkFont(f: StdFont | undefined): void {
  if (f !== undefined && !(f in DR_KEY))
    throw new TypeError(`font must be one of the Standard-14 faces, not '${String(f)}'`);
}

/** Validate a WidgetStyle, mutating nothing. Every creation and restyle path
 *  calls this before allocating, so a rejection leaves the document unchanged. */
export function checkWidgetStyle(s: WidgetStyle): NormalizedStyle {
  const bg = checkColor('backgroundColor', s.backgroundColor);
  const bc = checkColor('borderColor', s.borderColor);

  const width = s.borderWidth;
  if (width !== undefined
      && (typeof width !== 'number' || !Number.isFinite(width) || width < 0))
    throw new TypeError('borderWidth must be a non-negative number');

  const style = s.borderStyle;
  if (style !== undefined && !BORDER_STYLES.includes(style))
    throw new TypeError(`borderStyle must be one of ${BORDER_STYLES.join(', ')}`);

  let dash: number[] | undefined;
  if (s.dashPattern !== undefined) {
    if (!Array.isArray(s.dashPattern) || s.dashPattern.length === 0)
      throw new TypeError('dashPattern must be a non-empty array of numbers');
    if (!s.dashPattern.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0))
      throw new TypeError('dashPattern entries must be positive finite numbers');
    // Stored and ignored on any other style, so the field would come out looking
    // nothing like the call that made it.
    if (style !== 'dashed')
      throw new RangeError("dashPattern requires borderStyle 'dashed'");
    dash = [...s.dashPattern];
  }

  const rotate = s.rotate;
  if (rotate !== undefined && !ROTATIONS.includes(rotate))
    throw new TypeError(`rotate must be one of ${ROTATIONS.join(', ')}`);

  return { bg, bc, width, style, dash, rotate };
}

/** Validate the whole FieldStyle. The text half is checked here so a restyle
 *  rejects before writing any of the widget half. */
export function checkFieldStyle(s: FieldStyle): NormalizedStyle {
  checkFont(s.font);
  if (s.fontSize !== undefined
      && (typeof s.fontSize !== 'number' || !Number.isFinite(s.fontSize) || s.fontSize < 0))
    throw new TypeError('fontSize must be a non-negative number');
  checkColor('textColor', s.textColor);
  return checkWidgetStyle(s);
}

/** Write a validated style's /MK and /BS onto one widget. Absent keys are left
 *  alone; a null colour writes the empty array that paints nothing.
 *
 *  /BS is created only when a border key was given. A field with no border
 *  writes no /BS rather than one with /W 0 — mkOps already paints no border
 *  when /BC is absent, so the empty dict would be noise in every saved file. */
export function applyWidgetStyle(doc: Document, widget: PdfDict, s: NormalizedStyle): void {
  if (s.bg !== undefined || s.bc !== undefined || s.rotate !== undefined) {
    let mk = doc.resolve(widget.get('MK'));
    if (!isDict(mk)) { mk = new Map<string, PdfObject>(); widget.set('MK', mk); }
    if (s.bg !== undefined) (mk as PdfDict).set('BG', s.bg ?? []);
    if (s.bc !== undefined) (mk as PdfDict).set('BC', s.bc ?? []);
    // 0 is written rather than deleted: it is how a caller turns a rotation
    // back off, and /MK /R 0 is the specification's own default anyway.
    if (s.rotate !== undefined) (mk as PdfDict).set('R', s.rotate);
  }

  if (s.bc === undefined && s.width === undefined
      && s.style === undefined && s.dash === undefined) return;

  let bs = doc.resolve(widget.get('BS'));
  if (!isDict(bs)) {
    bs = new Map<string, PdfObject>([['Type', name('Border')]]);
    widget.set('BS', bs);
  }
  (bs as PdfDict).set('W', s.width ?? 1);
  (bs as PdfDict).set('S', name(BS_S[s.style ?? 'solid']));
  if (s.dash) (bs as PdfDict).set('D', s.dash);
}
