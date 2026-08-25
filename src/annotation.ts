import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfRef, PdfStream, isArray, isDict, isName, isRef, isStream, isString, name } from './types.js';
import { decodePdfText, encodePdfText, formatPdfDate, parsePdfDate } from './metadata.js';
import { widgetGeom, buildAppearanceXObject, installAP, type WidgetGeom } from './appearance.js';
import {
  quadsBBox, offsetQuads, installShapeAP, drawRect, drawEllipse, drawHighlight,
  drawUnderline, drawStrikeOut, drawSquiggly, drawEnding, polyPathBody,
  freeTextBoxBody, paddedRect, toFormSpace, unitDir, redactMarkBody, caretBody, AP_FONT_KEY,
  type QuadCorners,
} from './annotdraw.js';

export { quadsBBox, offsetQuads, type QuadCorners };
import { measure } from './metrics.js';
import { encodeWinAnsi } from './encoding.js';
import { serializeString, enc } from './serialize.js';
import { parseDA } from './da.js';
import { flattenAnnotation } from './flatten.js';
import { removeField } from './formremove.js';
import { num } from './pagecontent.js';
import { buildImageXObject, type BuiltImage } from './imageembed.js';
import { parseDest, encodeDest, type OutlineDest, type OutlineView } from './outline.js';
import { encodeAction, parseAction, type PdfAction } from './actions.js';
import {
  buildFilespec, readFilespecBytes, filespecName, upsertEmbeddedFile,
  type AttachmentOptions,
} from './embeddedfile.js';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import type { Layer } from './ocg.js';

// Annotation flag bits (/F), PDF 32000-1 §12.5.3.
const FLAG_HIDDEN = 1 << 1; // bit 2, value 2
const FLAG_PRINT = 1 << 2;  // bit 3, value 4

/** Read an n-length array of resolved numbers from `o`, or undefined. */
function numArray(doc: Document, o: PdfObject | undefined, n: number): number[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a) || a.length < n) return undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number') return undefined;
    out.push(v);
  }
  return out;
}

/** Validate an array of exactly `n` finite numbers; returns a defensive copy. */
export function checkNums(key: string, v: number[], n: number): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new TypeError(`${key} must be ${n} finite numbers`);
  }
  return [...v];
}

/** A PdfString tagged object carrying a PDF text string. */
function pdfText(s: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(s) };
}

/** A PDF text string entry, decoded; undefined when absent or not a string.
 *  Shared by every accessor over a plain text-string key (/T today).
 *
 *  Exported for `annotsearch.ts`, which sweeps the entries an annotation
 *  CARRIES (/Contents, /T, /Subj) off dicts of any subtype and so has no
 *  accessor to go through — the reason `readRichTextValue` is exported from
 *  `formfield.ts`. Decoding a text string keeps one owner. */
export function readTextString(doc: Document, dict: PdfDict, key: string): string | undefined {
  const s = doc.resolve(dict.get(key));
  return isString(s) ? decodePdfText(s.bytes) : undefined;
}

/** Write (or delete, when `v` is undefined) a PDF text string entry. `label` is
 *  the public property name, so the thrown message names what the caller wrote. */
function writeTextString(dict: PdfDict, key: string, v: string | undefined, label: string): void {
  if (v === undefined) { dict.delete(key); return; }
  if (typeof v !== 'string') throw new TypeError(`${label} must be a string`);
  dict.set(key, pdfText(v));
}

/** A live, mutable handle over an annotation dictionary. */
export class Annotation {
  constructor(
    protected readonly doc: Document,
    /** The live annotation dict from the objects map (not a copy). */
    readonly Dict: PdfDict,
  ) {}

  /** Flag the owning document as modified after an in-place edit so a later
   *  {@link Document.Sign} rewrites in full rather than dropping the change in an
   *  incremental append. Every setter on this handle (and its subclasses) calls
   *  it. */
  protected touch(): void {
    this.doc.markModified();
  }

  /** Bake just this annotation into static page content: draw its /AP /N
   *  appearance into the page's /Contents at its /Rect and drop it from
   *  /Annots. Other annotations are untouched — the per-annotation counterpart
   *  to `Page.FlattenAnnotations`. False when there was nothing to bake: an
   *  annotation a viewer would not draw (Hidden, NoView, /Popup) or one with no
   *  usable appearance stays in place.
   *
   *  A widget is unwired from /AcroForm /Fields as well. Baking the ink alone
   *  would leave the field reachable from /Root with a value and no widget
   *  anywhere — the leftover-field state `Form.RemoveField` exists to avoid. */
  Flatten(): boolean {
    if (!flattenAnnotation(this.doc, this.Dict)) return false;
    // A no-op for anything that is not in the field tree, matched by identity.
    removeField(this.doc, this.Dict);
    return true;
  }

  /** /Subtype name without leading '/'; '' when missing. */
  get Subtype(): string {
    const s = this.Dict.get('Subtype');
    return isName(s) ? s.name : '';
  }

  /** /Rect as [llx, lly, urx, ury]; undefined when missing or malformed. */
  get Rect(): [number, number, number, number] | undefined {
    const r = numArray(this.doc, this.Dict.get('Rect'), 4);
    return r ? [r[0], r[1], r[2], r[3]] : undefined;
  }

  set Rect(v: [number, number, number, number] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('Rect'); return; }
    this.Dict.set('Rect', checkNums('Rect', v, 4));
  }

  /** /C as RGB [r, g, b] in 0..1; undefined when absent or not 3-component. */
  get Color(): [number, number, number] | undefined {
    const c = numArray(this.doc, this.Dict.get('C'), 3);
    return c ? [c[0], c[1], c[2]] : undefined;
  }

  set Color(v: [number, number, number] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('C'); return; }
    const c = checkNums('Color', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('Color components must be in 0..1');
    this.Dict.set('C', c);
  }

  /** /Contents text; undefined when absent. */
  get Contents(): string | undefined {
    const s = this.doc.resolve(this.Dict.get('Contents'));
    return isString(s) ? decodePdfText(s.bytes) : undefined;
  }

  set Contents(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('Contents'); return; }
    if (typeof v !== 'string') throw new TypeError('Contents must be a string');
    this.Dict.set('Contents', pdfText(v));
  }

  /** /NM annotation name; undefined when absent. */
  get Name(): string | undefined {
    const s = this.doc.resolve(this.Dict.get('NM'));
    return isString(s) ? decodePdfText(s.bytes) : undefined;
  }

  set Name(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('NM'); return; }
    if (typeof v !== 'string') throw new TypeError('Name must be a string');
    this.Dict.set('NM', pdfText(v));
  }

  /** Optional-content layer this annotation belongs to (via /OC); undefined when
   *  absent. Setting to undefined removes /OC. */
  get Layer(): Layer | undefined {
    return this.doc.OptionalContent.layerForRef(this.Dict.get('OC'));
  }

  set Layer(v: Layer | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('OC'); return; }
    this.Dict.set('OC', v.Ref);
  }

  /** /M modification date (parsed Date, or raw string when unparseable). */
  get ModDate(): Date | string | undefined {
    const s = this.doc.resolve(this.Dict.get('M'));
    return isString(s) ? parsePdfDate(decodePdfText(s.bytes)) : undefined;
  }

  set ModDate(v: Date | string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('M'); return; }
    const text = v instanceof Date ? formatPdfDate(v) : String(v);
    this.Dict.set('M', pdfText(text));
  }

  /** /F flag bitfield; 0 when absent. */
  get Flags(): number {
    const f = this.doc.resolve(this.Dict.get('F'));
    return typeof f === 'number' ? f : 0;
  }

  set Flags(v: number) {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError('Flags must be an integer');
    this.Dict.set('F', v);
    this.touch();
  }

  get Print(): boolean { return (this.Flags & FLAG_PRINT) !== 0; }
  set Print(v: boolean) { this.Flags = v ? (this.Flags | FLAG_PRINT) : (this.Flags & ~FLAG_PRINT); }

  get Hidden(): boolean { return (this.Flags & FLAG_HIDDEN) !== 0; }
  set Hidden(v: boolean) { this.Flags = v ? (this.Flags | FLAG_HIDDEN) : (this.Flags & ~FLAG_HIDDEN); }

  /** /CA constant opacity in 0..1; undefined when absent. */
  get Opacity(): number | undefined {
    const a = this.doc.resolve(this.Dict.get('CA'));
    return typeof a === 'number' ? a : undefined;
  }

  set Opacity(v: number | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('CA'); return; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new TypeError('Opacity must be in 0..1');
    this.Dict.set('CA', v);
  }
}

/** A /Text (sticky-note) annotation: an icon-and-popup markup with no appearance
 *  stream. Adds the note-specific entries to the base Annotation handle. */
export class TextAnnotation extends Annotation {
  /** /Name icon (e.g. Note, Comment, Help, Insert, Key, NewParagraph, Paragraph);
   *  undefined when absent. */
  get Icon(): string | undefined {
    const n = this.Dict.get('Name');
    return isName(n) ? n.name : undefined;
  }

  set Icon(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('Name'); return; }
    if (typeof v !== 'string') throw new TypeError('Icon must be a string');
    this.Dict.set('Name', name(v));
  }

  /** /Open: whether the note's popup is initially displayed open. false when absent. */
  get Open(): boolean {
    return this.doc.resolve(this.Dict.get('Open')) === true;
  }

  set Open(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Open must be a boolean');
    this.Dict.set('Open', v);
    this.touch();
  }

  /** /T text label (the note's author); undefined when absent. */
  get Author(): string | undefined { return readTextString(this.doc, this.Dict, 'T'); }

  set Author(v: string | undefined) {
    this.touch();
    writeTextString(this.Dict, 'T', v, 'Author');
  }
}

/** A /Stamp (rubber-stamp) annotation. /Name holds the stamp name for standard
 *  stamps (Approved, Confidential, Draft, …); custom text/image stamps leave it
 *  unset and carry their content in the /AP appearance. */
export class StampAnnotation extends Annotation {
  /** /Name stamp name; undefined when absent (custom text/image stamps). */
  get StampName(): string | undefined {
    const n = this.Dict.get('Name');
    return isName(n) ? n.name : undefined;
  }

  set StampName(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('Name'); return; }
    if (typeof v !== 'string') throw new TypeError('StampName must be a string');
    this.Dict.set('Name', name(v));
  }
}

/** The four text-markup subtypes, lower-cased. */
export type MarkupType = 'highlight' | 'underline' | 'strikeout' | 'squiggly';

const MARKUP_SUBTYPES: Record<string, MarkupType> = {
  Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly',
};

/** /QuadPoints as a flat list of 8·n finite numbers; [] when absent. Shared by
 *  MarkupAnnotation and RedactAnnotation — one copy of the grammar. */
function readQuadPoints(doc: Document, dict: PdfDict): number[] {
  const a = doc.resolve(dict.get('QuadPoints'));
  if (!isArray(a)) return [];
  const out: number[] = [];
  for (const e of a) { const v = doc.resolve(e); if (typeof v === 'number') out.push(v); }
  return out;
}

/** Validate and write /QuadPoints: a non-empty list of finite numbers, 8·n. */
function writeQuadPoints(dict: PdfDict, q: number[]): void {
  if (!Array.isArray(q) || q.length === 0 || q.length % 8 !== 0 ||
      !q.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError('QuadPoints must be a non-empty list of finite numbers, length a multiple of 8');
  dict.set('QuadPoints', [...q]);
}

/** /Q justification as 'left' | 'center' | 'right' (0/1/2). */
function readAlignment(doc: Document, dict: PdfDict): 'left' | 'center' | 'right' {
  const q = doc.resolve(dict.get('Q'));
  return q === 1 ? 'center' : q === 2 ? 'right' : 'left';
}

function writeAlignment(dict: PdfDict, v: 'left' | 'center' | 'right'): void {
  dict.set('Q', v === 'center' ? 1 : v === 'right' ? 2 : 0);
}

/** /IC interior colour [r,g,b] in 0..1; undefined when absent. */
function readInteriorColor(doc: Document, dict: PdfDict): [number, number, number] | undefined {
  const c = numArray(doc, dict.get('IC'), 3);
  return c ? [c[0], c[1], c[2]] : undefined;
}

function writeInteriorColor(dict: PdfDict, v: [number, number, number] | undefined): void {
  if (v === undefined) { dict.delete('IC'); return; }
  const c = checkNums('InteriorColor', v, 3);
  if (c.some((x) => x < 0 || x > 1)) throw new TypeError('InteriorColor components must be in 0..1');
  dict.set('IC', c);
}

/** Parsed /DA (font resource name, size, colour); Helv/0/black when absent. */
function readDA(doc: Document, dict: PdfDict): { fontName: string; size: number; color: [number, number, number] } {
  const s = doc.resolve(dict.get('DA'));
  return parseDA(isString(s) ? new TextDecoder('latin1').decode(s.bytes) : '');
}

/** A text-markup annotation (/Highlight, /Underline, /StrikeOut, /Squiggly)
 *  positioned by /QuadPoints (8 numbers per marked quad). */
export class MarkupAnnotation extends Annotation {
  /** Lower-cased markup kind derived from /Subtype. */
  get MarkupType(): MarkupType {
    return MARKUP_SUBTYPES[this.Subtype] ?? 'highlight';
  }

  /** /QuadPoints as a flat list of 8·n finite numbers; [] when absent. */
  get QuadPoints(): number[] { return readQuadPoints(this.doc, this.Dict); }

  set QuadPoints(q: number[]) { writeQuadPoints(this.Dict, q); this.touch(); }
}

/** Border width from /BS /W; default 1 when absent or malformed. */
function readBorderWidth(doc: Document, dict: PdfDict): number {
  const bs = doc.resolve(dict.get('BS'));
  if (isDict(bs)) {
    const w = doc.resolve((bs as PdfDict).get('W'));
    if (typeof w === 'number' && Number.isFinite(w)) return w;
  }
  return 1;
}

/** Write /BS << /Type /Border /W v >>. Validates a non-negative finite number. */
function setBorderWidth(dict: PdfDict, v: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new TypeError('BorderWidth must be a non-negative finite number');
  dict.set('BS', new Map<string, PdfObject>([['Type', name('Border')], ['W', v]]));
}

/** 'square' or 'circle' — the two subtypes SquareCircleAnnotation covers. */
export type ShapeType = 'square' | 'circle';

/** A /Square or /Circle annotation: a stroked (optionally filled) rectangle or
 *  inscribed ellipse in /Rect. */
export class SquareCircleAnnotation extends Annotation {
  /** 'circle' for /Circle, else 'square'. */
  get ShapeType(): ShapeType {
    return this.Subtype === 'Circle' ? 'circle' : 'square';
  }

  /** /IC interior fill color RGB [r,g,b] in 0..1; undefined when absent. */
  get InteriorColor(): [number, number, number] | undefined {
    const c = numArray(this.doc, this.Dict.get('IC'), 3);
    return c ? [c[0], c[1], c[2]] : undefined;
  }

  set InteriorColor(v: [number, number, number] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('IC'); return; }
    const c = checkNums('InteriorColor', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('InteriorColor components must be in 0..1');
    this.Dict.set('IC', c);
  }

  /** Border width from /BS /W; 1 when absent. */
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }
}

/** Supported /LE line-ending styles. */
export type LineEnding = 'None' | 'OpenArrow' | 'ClosedArrow' | 'Circle' | 'Square';

const LINE_ENDINGS: ReadonlySet<string> = new Set<string>([
  'None', 'OpenArrow', 'ClosedArrow', 'Circle', 'Square',
]);

/** A /Line annotation: a straight segment between /L endpoints with optional
 *  /LE endings (arrowheads/shapes) at each end. */
export class LineAnnotation extends Annotation {
  /** /L endpoints [x1,y1,x2,y2]; undefined when missing/malformed. */
  get Line(): [number, number, number, number] | undefined {
    const l = numArray(this.doc, this.Dict.get('L'), 4);
    return l ? [l[0], l[1], l[2], l[3]] : undefined;
  }

  set Line(v: [number, number, number, number] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('L'); return; }
    this.Dict.set('L', checkNums('Line', v, 4));
  }

  /** Border width from /BS /W; 1 when absent. */
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }

  /** /LE endings [start, end]; undefined when absent or malformed. */
  get LineEndings(): [LineEnding, LineEnding] | undefined {
    const le = this.doc.resolve(this.Dict.get('LE'));
    if (!isArray(le) || le.length < 2) return undefined;
    const s = this.doc.resolve(le[0]); const e = this.doc.resolve(le[1]);
    if (!isName(s) || !isName(e)) return undefined;
    return [s.name as LineEnding, e.name as LineEnding];
  }

  set LineEndings(v: [LineEnding, LineEnding] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('LE'); return; }
    if (!Array.isArray(v) || v.length !== 2 || !LINE_ENDINGS.has(v[0]) || !LINE_ENDINGS.has(v[1]))
      throw new TypeError('LineEndings must be [start, end] of supported ending names');
    this.Dict.set('LE', [name(v[0]), name(v[1])]);
  }
}

/** All resolved finite numbers in array `o`; [] when `o` is not an array. */
function readNumList(doc: Document, o: PdfObject | undefined): number[] {
  const a = doc.resolve(o);
  if (!isArray(a)) return [];
  const out: number[] = [];
  for (const e of a) { const v = doc.resolve(e); if (typeof v === 'number' && Number.isFinite(v)) out.push(v); }
  return out;
}

/** Validate a flat point list: an even-length list of ≥4 finite numbers (at least
 *  two points). Returns a defensive copy. */
function checkVertices(key: string, v: number[]): number[] {
  if (!Array.isArray(v) || v.length < 4 || v.length % 2 !== 0 ||
      !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError(`${key} must be an even-length list of at least 4 finite numbers`);
  return [...v];
}

/** 'polygon' or 'polyline' — the two subtypes PolyAnnotation covers. */
export type PolyType = 'polygon' | 'polyline';

/** A /Polygon (closed) or /PolyLine (open) annotation: a multi-vertex path in
 *  /Vertices, optionally filled (/IC) and, for polylines, capped with /LE
 *  endings. */
export class PolyAnnotation extends Annotation {
  /** 'polyline' for /PolyLine, else 'polygon'. */
  get PolyType(): PolyType {
    return this.Subtype === 'PolyLine' ? 'polyline' : 'polygon';
  }

  /** /Vertices as a flat list [x1,y1,x2,y2,…]; [] when absent. */
  get Vertices(): number[] { return readNumList(this.doc, this.Dict.get('Vertices')); }

  set Vertices(v: number[]) {
    this.Dict.set('Vertices', checkVertices('Vertices', v));
    this.touch();
  }

  /** /IC interior fill color RGB [r,g,b] in 0..1; undefined when absent. */
  get InteriorColor(): [number, number, number] | undefined {
    const c = numArray(this.doc, this.Dict.get('IC'), 3);
    return c ? [c[0], c[1], c[2]] : undefined;
  }

  set InteriorColor(v: [number, number, number] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('IC'); return; }
    const c = checkNums('InteriorColor', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('InteriorColor components must be in 0..1');
    this.Dict.set('IC', c);
  }

  /** Border width from /BS /W; 1 when absent. */
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }

  /** /LE endings [start, end] (for /PolyLine); undefined when absent/malformed. */
  get LineEndings(): [LineEnding, LineEnding] | undefined {
    const le = this.doc.resolve(this.Dict.get('LE'));
    if (!isArray(le) || le.length < 2) return undefined;
    const s = this.doc.resolve(le[0]); const e = this.doc.resolve(le[1]);
    if (!isName(s) || !isName(e)) return undefined;
    return [s.name as LineEnding, e.name as LineEnding];
  }

  set LineEndings(v: [LineEnding, LineEnding] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('LE'); return; }
    if (!Array.isArray(v) || v.length !== 2 || !LINE_ENDINGS.has(v[0]) || !LINE_ENDINGS.has(v[1]))
      throw new TypeError('LineEndings must be [start, end] of supported ending names');
    this.Dict.set('LE', [name(v[0]), name(v[1])]);
  }
}

/** An /Ink annotation: one or more freehand strokes, each a flat point list in
 *  /InkList. */
export class InkAnnotation extends Annotation {
  /** /InkList as one flat point list per stroke; [] when absent. Strokes with
   *  fewer than two points are dropped. */
  get InkList(): number[][] {
    const a = this.doc.resolve(this.Dict.get('InkList'));
    if (!isArray(a)) return [];
    return a.map((s) => readNumList(this.doc, s)).filter((s) => s.length >= 2 && s.length % 2 === 0);
  }

  set InkList(v: number[][]) {
    if (!Array.isArray(v) || v.length === 0)
      throw new TypeError('InkList must be a non-empty array of strokes');
    this.Dict.set('InkList', v.map((s) => checkVertices('ink stroke', s)));
    this.touch();
  }

  /** Border width from /BS /W; 1 when absent. */
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }
}

/** Build a /DA PDF string `/<font> <size> Tf r g b rg` (ASCII/latin1). */
function buildDA(fontName: string, size: number, color: [number, number, number]): PdfObject {
  const [r, g, b] = color;
  return { kind: 'string', bytes: enc(`/${fontName} ${num(size)} Tf ${num(r)} ${num(g)} ${num(b)} rg`) };
}

/** A /FreeText annotation: text drawn directly on the page, optionally with a
 *  callout leader line (/CL, /IT FreeTextCallout, /LE ending). */
export class FreeTextAnnotation extends Annotation {
  /** Parsed /DA (font resource name, size, color); Helvetica/0/black default. */
  private da(): { fontName: string; size: number; color: [number, number, number] } {
    return readDA(this.doc, this.Dict);
  }

  /** /Q text justification as 'left' | 'center' | 'right' (0/1/2). */
  get Alignment(): 'left' | 'center' | 'right' { return readAlignment(this.doc, this.Dict); }

  set Alignment(v: 'left' | 'center' | 'right') { this.touch(); writeAlignment(this.Dict, v); }

  /** /DA font size (0 = auto). */
  get FontSize(): number { return this.da().size; }

  set FontSize(v: number) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError('FontSize must be a non-negative finite number');
    this.touch();
    const d = this.da();
    this.Dict.set('DA', buildDA(d.fontName, v, d.color));
  }

  /** /DA fill color [r,g,b] in 0..1. */
  get TextColor(): [number, number, number] { return this.da().color; }

  set TextColor(v: [number, number, number]) {
    const c = checkNums('TextColor', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('TextColor components must be in 0..1');
    this.touch();
    const d = this.da();
    this.Dict.set('DA', buildDA(d.fontName, d.size, [c[0], c[1], c[2]]));
  }

  /** Border width from /BS /W; 1 when absent. */
  get BorderWidth(): number { return readBorderWidth(this.doc, this.Dict); }
  set BorderWidth(v: number) { setBorderWidth(this.Dict, v); this.touch(); }

  /** /IC interior (box background) color [r,g,b] in 0..1; undefined when absent. */
  get InteriorColor(): [number, number, number] | undefined {
    return readInteriorColor(this.doc, this.Dict);
  }

  set InteriorColor(v: [number, number, number] | undefined) {
    this.touch();
    writeInteriorColor(this.Dict, v);
  }

  /** /IT intent name; undefined when absent. */
  get Intent(): string | undefined {
    const n = this.Dict.get('IT');
    return isName(n) ? n.name : undefined;
  }

  set Intent(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('IT'); return; }
    if (typeof v !== 'string') throw new TypeError('Intent must be a string');
    this.Dict.set('IT', name(v));
  }

  /** /CL callout line: 4 or 6 finite numbers; undefined when absent/malformed. */
  get CalloutLine(): number[] | undefined {
    const a = this.doc.resolve(this.Dict.get('CL'));
    if (!isArray(a) || (a.length !== 4 && a.length !== 6)) return undefined;
    const out: number[] = [];
    for (const e of a) { const v = this.doc.resolve(e); if (typeof v !== 'number') return undefined; out.push(v); }
    return out;
  }

  set CalloutLine(v: number[] | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('CL'); return; }
    if (!Array.isArray(v) || (v.length !== 4 && v.length !== 6) || !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
      throw new TypeError('CalloutLine must be 4 or 6 finite numbers');
    this.Dict.set('CL', [...v]);
  }

  /** /LE single line-ending name; undefined when absent. */
  get CalloutEnding(): LineEnding | undefined {
    const le = this.doc.resolve(this.Dict.get('LE'));
    return isName(le) ? (le.name as LineEnding) : undefined;
  }

  set CalloutEnding(v: LineEnding | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('LE'); return; }
    if (!LINE_ENDINGS.has(v)) throw new TypeError('CalloutEnding must be a supported ending name');
    this.Dict.set('LE', name(v));
  }
}

/** A /Caret annotation (PDF 32000-1 §12.5.6.11): a text-insertion mark, drawn as
 *  a wedge at the point where text should be added, optionally with a paragraph
 *  sign. */
export class CaretAnnotation extends Annotation {
  /** /Sy symbol: 'paragraph' for /P, 'none' otherwise. An unrecognised name
   *  reads as 'none' — a foreign dict is not worth throwing over. */
  get Symbol(): 'none' | 'paragraph' {
    const s = this.Dict.get('Sy');
    return isName(s) && s.name === 'P' ? 'paragraph' : 'none';
  }

  set Symbol(v: 'none' | 'paragraph') {
    if (v !== 'none' && v !== 'paragraph')
      throw new TypeError("Symbol must be 'none' or 'paragraph'");
    this.touch();
    this.Dict.set('Sy', name(v === 'paragraph' ? 'P' : 'None'));
  }

  /** /T text label (who marked the insertion); undefined when absent. */
  get Author(): string | undefined { return readTextString(this.doc, this.Dict, 'T'); }

  set Author(v: string | undefined) {
    this.touch();
    writeTextString(this.Dict, 'T', v, 'Author');
  }
}

/** A /Redact annotation (PDF 32000-1 §12.5.6.23): a *mark* over a region, plus
 *  the overlay to paint when it is applied. Marking removes nothing — see
 *  `Page.ApplyRedactions`. */
export class RedactAnnotation extends Annotation {
  /** /QuadPoints as a flat list of 8·n finite numbers; [] when absent. */
  get QuadPoints(): number[] { return readQuadPoints(this.doc, this.Dict); }
  set QuadPoints(q: number[]) { writeQuadPoints(this.Dict, q); this.touch(); }

  /** /IC — the colour painted over the region on apply; undefined when absent. */
  get InteriorColor(): [number, number, number] | undefined {
    return readInteriorColor(this.doc, this.Dict);
  }
  set InteriorColor(v: [number, number, number] | undefined) {
    this.touch();
    writeInteriorColor(this.Dict, v);
  }

  /** /Q justification of the overlay text. */
  get Alignment(): 'left' | 'center' | 'right' { return readAlignment(this.doc, this.Dict); }
  set Alignment(v: 'left' | 'center' | 'right') { this.touch(); writeAlignment(this.Dict, v); }

  /** /OverlayText drawn over the filled region on apply; undefined when absent. */
  get OverlayText(): string | undefined {
    const s = this.doc.resolve(this.Dict.get('OverlayText'));
    return isString(s) ? decodePdfText(s.bytes) : undefined;
  }
  set OverlayText(v: string | undefined) {
    this.touch();
    if (v === undefined) { this.Dict.delete('OverlayText'); return; }
    if (typeof v !== 'string') throw new TypeError('OverlayText must be a string');
    this.Dict.set('OverlayText', pdfText(v));
  }

  /** /Repeat — tile the overlay text to fill the region. False when absent. */
  get Repeat(): boolean { return this.doc.resolve(this.Dict.get('Repeat')) === true; }
  set Repeat(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Repeat must be a boolean');
    this.touch();
    this.Dict.set('Repeat', v);
  }

  /** /DA font size (0 = auto). */
  get FontSize(): number { return readDA(this.doc, this.Dict).size; }
  set FontSize(v: number) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      throw new TypeError('FontSize must be a non-negative finite number');
    this.touch();
    const d = readDA(this.doc, this.Dict);
    this.Dict.set('DA', buildDA(d.fontName, v, d.color));
  }

  /** /DA fill colour [r,g,b] in 0..1 — the overlay text colour. */
  get TextColor(): [number, number, number] { return readDA(this.doc, this.Dict).color; }
  set TextColor(v: [number, number, number]) {
    const c = checkNums('TextColor', v, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('TextColor components must be in 0..1');
    this.touch();
    const d = readDA(this.doc, this.Dict);
    this.Dict.set('DA', buildDA(d.fontName, d.size, [c[0], c[1], c[2]]));
  }

  /** /T text label (who marked it); undefined when absent. */
  get Author(): string | undefined { return readTextString(this.doc, this.Dict, 'T'); }

  set Author(v: string | undefined) {
    this.touch();
    writeTextString(this.Dict, 'T', v, 'Author');
  }

  /** /RO overlay appearance form XObject; undefined when absent. Read-only: we
   *  honour one another producer wrote, but never author one — /IC plus
   *  /OverlayText already say what it would say. */
  get Overlay(): PdfStream | undefined {
    const s = this.doc.resolve(this.Dict.get('RO'));
    return isStream(s) ? s : undefined;
  }
}

/** A /Popup annotation: a companion window bound to a parent markup via /Parent
 *  (the parent carries /Popup back). No appearance stream. */
export class PopupAnnotation extends Annotation {
  /** /Open: whether the popup is initially displayed open. false when absent. */
  get Open(): boolean {
    return this.doc.resolve(this.Dict.get('Open')) === true;
  }

  set Open(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Open must be a boolean');
    this.Dict.set('Open', v);
    this.touch();
  }

  /** The parent markup annotation this popup belongs to (/Parent), as a typed
   *  handle; undefined when absent. */
  get Parent(): Annotation | undefined {
    const p = this.doc.resolve(this.Dict.get('Parent'));
    return isDict(p) ? wrapAnnotation(this.doc, p as PdfDict) : undefined;
  }
}

/** A GoTo action: jump to a 1-based page with an optional view. */
export type {
  GoToAction, UriAction, SubmitAction, ResetAction, JavaScriptAction, PdfAction,
} from './actions.js';
/** @deprecated Use PdfAction. Retained so existing imports keep working. */
export type LinkAction = PdfAction;

/** A /Link annotation. Exposes the parsed /A action (GoTo / URI) and, for GoTo
 *  links, the resolved destination (also covering an explicit /Dest). */
export class LinkAnnotation extends Annotation {
  /** The link's /A action as structured data; undefined when absent or of an
   *  unmodeled action type. */
  get Action(): PdfAction | undefined {
    return parseAction(this.doc, this.Dict);
  }

  /** The resolved GoTo destination from /Dest or an /A GoTo action; undefined
   *  for URI links or unresolvable dests. */
  get Dest(): OutlineDest | undefined {
    return parseDest(this.doc, this.Dict, (o) => this.doc.pageNumberOf(o));
  }
}

/** A /FileAttachment annotation: an icon on the page whose /FS embeds a file. */
export class FileAttachmentAnnotation extends Annotation {
  /** The /Name icon key (PushPin, Paperclip, Graph, Tag). */
  get Icon(): string {
    const n = this.Dict.get('Name');
    return isName(n) ? n.name : 'PushPin';
  }
  set Icon(v: string) { this.Dict.set('Name', name(v)); this.touch(); }

  /** The embedded file's display name (from the /FS filespec). */
  get FileName(): string {
    const fs = this.doc.resolve(this.Dict.get('FS'));
    return isDict(fs) ? filespecName(this.doc, fs) : '';
  }

  /** The filespec's /Desc, if any. */
  get Description(): string | undefined {
    const fs = this.doc.resolve(this.Dict.get('FS'));
    if (!isDict(fs)) return undefined;
    const d = fs.get('Desc');
    return isString(d) ? decodePdfText(d.bytes) : undefined;
  }

  /** Decode the embedded bytes. */
  GetBytes(): Uint8Array {
    const fs = this.Dict.get('FS');
    if (fs === undefined) throw new PdfParseError('file attachment: missing /FS');
    return readFilespecBytes(this.doc, fs);
  }
}

/** Wrap an annotation dict in its typed handle, dispatching on /Subtype. Unknown
 *  subtypes fall back to the base `Annotation`. */
export function wrapAnnotation(doc: Document, dict: PdfDict): Annotation {
  const st = dict.get('Subtype');
  const subtype = isName(st) ? st.name : '';
  switch (subtype) {
    case 'Text': return new TextAnnotation(doc, dict);
    case 'Stamp': return new StampAnnotation(doc, dict);
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': return new MarkupAnnotation(doc, dict);
    case 'Link': return new LinkAnnotation(doc, dict);
    case 'FileAttachment': return new FileAttachmentAnnotation(doc, dict);
    case 'Square':
    case 'Circle': return new SquareCircleAnnotation(doc, dict);
    case 'Line': return new LineAnnotation(doc, dict);
    case 'Polygon':
    case 'PolyLine': return new PolyAnnotation(doc, dict);
    case 'Ink': return new InkAnnotation(doc, dict);
    case 'FreeText': return new FreeTextAnnotation(doc, dict);
    case 'Redact': return new RedactAnnotation(doc, dict);
    case 'Caret': return new CaretAnnotation(doc, dict);
    case 'Popup': return new PopupAnnotation(doc, dict);
    default: return new Annotation(doc, dict);
  }
}

/** The page's own live /Annots array, created and attached when absent.
 *  @internal Shared with formcreate.ts, which attaches widget annotations the
 *  same way — a widget must land on the page's *own* array, never an inherited
 *  one. */
export function ownAnnots(doc: Document, page: Page): PdfObject[] {
  const existing = doc.resolve(page.Dict.get('Annots'));
  if (isArray(existing)) return existing;
  const arr: PdfObject[] = [];
  page.Dict.set('Annots', arr);
  return arr;
}

/** Popup placement for AddPopup / auto-popup. */
export interface PopupSpec {
  /** Popup window box; defaults to a ~200×100 box beside the parent's /Rect. */
  rect?: [number, number, number, number];
  /** /Open initial state. Default false. */
  open?: boolean;
}

/** Common fields accepted by every annotation constructor. */
export interface BaseAnnotInit {
  subtype: string;
  rect: [number, number, number, number];
  color?: [number, number, number];
  contents?: string;
  /** Auto-attach a companion /Popup to the created annotation. */
  popup?: PopupSpec;
}

/** @internal Build an annotation dict, attach it to the page's own /Annots, and
 *  return the live dict. Sets /Type, /Subtype, /Rect, default /F Print, /M now,
 *  and /P -> the page. Validates all inputs before allocating any object. */
export function createAnnotation(doc: Document, page: Page, init: BaseAnnotInit): PdfDict {
  if (init.popup?.rect !== undefined) checkNums('popup rect', init.popup.rect, 4);
  const dict: PdfDict = new Map<string, PdfObject>();
  dict.set('Type', name('Annot'));
  dict.set('Subtype', name(init.subtype));
  dict.set('Rect', checkNums('rect', init.rect, 4));
  dict.set('F', FLAG_PRINT);
  dict.set('M', pdfText(formatPdfDate(new Date())));
  if (init.color !== undefined) {
    const c = checkNums('color', init.color, 3);
    if (c.some((x) => x < 0 || x > 1)) throw new TypeError('color components must be in 0..1');
    dict.set('C', c);
  }
  if (init.contents !== undefined) {
    if (typeof init.contents !== 'string') throw new TypeError('contents must be a string');
    dict.set('Contents', pdfText(init.contents));
  }
  dict.set('P', doc.pageRef(page.Number));
  const r = doc.allocObject(dict);
  ownAnnots(doc, page).push(r);
  if (init.popup) createPopup(doc, page, r, init.popup, dict);
  return dict;
}

/** Options for Page.AddTextNote. */
export interface TextNoteOptions {
  rect: [number, number, number, number];
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
  /** /Contents body text. */
  contents?: string;
  /** /Name icon. Default 'Note'. */
  icon?: string;
  /** /Open popup state. Default false. */
  open?: boolean;
  /** /C colour, RGB 0..1. */
  color?: [number, number, number];
  /** /T author label. */
  author?: string;
}

/** Build and attach a /Text (sticky-note) annotation to `page`; returns its
 *  TextAnnotation handle. Icon defaults to 'Note'. */
export function addTextNote(doc: Document, page: Page, opts: TextNoteOptions): TextAnnotation {
  const dict = createAnnotation(doc, page, {
    subtype: 'Text',
    rect: opts.rect,
    color: opts.color,
    contents: opts.contents,
    popup: opts.popup,
  });
  const note = new TextAnnotation(doc, dict);
  note.Icon = opts.icon ?? 'Note';
  if (opts.open !== undefined) note.Open = opts.open;
  if (opts.author !== undefined) note.Author = opts.author;
  return note;
}

/** Options for Page.AddStamp. Exactly one of `name`, `text`, or `image`.
 *  (Named distinctly from `StampOptions` in stamp.ts, which configures the
 *  unrelated text-stamping `Page.AddText`.) */
export interface StampAnnotationOptions {
  rect: [number, number, number, number];
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
  /** Standard stamp name (Approved, Confidential, Draft, …); sets /Name. */
  name?: string;
  /** Custom text stamp label. */
  text?: string;
  /** Custom image stamp (JPEG/PNG bytes). */
  image?: Uint8Array;
  /** Frame/text color for name/text stamps, RGB 0..1. Default red [1,0,0]. */
  color?: [number, number, number];
}

const STAMP_FONT = 'Helvetica-Bold';

/** Largest font size for `bytes` fitting ~60% of box height and 85% of width. */
function labelSize(bytes: Uint8Array, g: WidgetGeom): number {
  let size = Math.min(g.h * 0.6, 24);
  const avail = g.w * 0.85;
  const w = measure(STAMP_FONT, bytes, size);
  if (w > avail && w > 0) size = Math.max(4, (size * avail) / w);
  return size;
}

/** Build a framed-label /AP form: a stroked border plus centered bold text. */
function buildLabelAppearance(
  doc: Document, g: WidgetGeom, label: string, color: [number, number, number],
): PdfStream {
  const [r, gg, b] = color;
  const bw = Math.max(1, Math.min(g.w, g.h) * 0.04);
  const half = bw / 2;
  const bytes = encodeWinAnsi(label);
  const size = labelSize(bytes, g);
  const tw = measure(STAMP_FONT, bytes, size);
  const x = (g.w - tw) / 2;
  const y = (g.h - size) / 2 + size * 0.2;
  const body =
    `${num(r)} ${num(gg)} ${num(b)} RG ${num(bw)} w ` +
    `${num(half)} ${num(half)} ${num(g.w - bw)} ${num(g.h - bw)} re S\n` +
    `BT /${AP_FONT_KEY} ${num(size)} Tf ${num(r)} ${num(gg)} ${num(b)} rg ` +
    `${num(x)} ${num(y)} Td ${serializeString(bytes)} Tj ET`;
  return buildAppearanceXObject(doc, g, STAMP_FONT, AP_FONT_KEY, body);
}

/** Build an /AP form that paints `built` (an Image XObject) to fill the box,
 *  registering it under /Im0 in the form's own /Resources. */
function buildImageAppearance(doc: Document, g: WidgetGeom, built: BuiltImage): PdfStream {
  if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
  const imgRef = doc.allocObject(built.stream);
  const body = `${num(g.w)} 0 0 ${num(g.h)} 0 0 cm\n/Im0 Do`;
  const stream = buildAppearanceXObject(doc, g, 'Helvetica', AP_FONT_KEY, body);
  (stream.dict.get('Resources') as PdfDict).set(
    'XObject', new Map<string, PdfObject>([['Im0', imgRef]]),
  );
  return stream;
}

/** Build and attach a /Stamp annotation to `page`; returns its StampAnnotation
 *  handle. Exactly one of opts.name / opts.text / opts.image must be set. */
export function addStamp(doc: Document, page: Page, opts: StampAnnotationOptions): StampAnnotation {
  const modes = [opts.name, opts.text, opts.image].filter((v) => v !== undefined);
  if (modes.length !== 1)
    throw new TypeError('AddStamp requires exactly one of name, text, or image');

  // Parse/validate the image before mutating the page (validate-before-attach).
  const built: BuiltImage | undefined =
    opts.image !== undefined ? buildImageXObject(opts.image) : undefined;

  const dict = createAnnotation(doc, page, {
    subtype: 'Stamp',
    rect: opts.rect,
    color: opts.color,
    popup: opts.popup,
  });
  const stamp = new StampAnnotation(doc, dict);
  const g = widgetGeom(doc, dict);
  const color = opts.color ?? [1, 0, 0];

  if (opts.name !== undefined) {
    stamp.StampName = opts.name;
    if (g) installAP(doc, dict, buildLabelAppearance(doc, g, opts.name, color));
  } else if (opts.text !== undefined) {
    if (typeof opts.text !== 'string') throw new TypeError('text must be a string');
    if (g) installAP(doc, dict, buildLabelAppearance(doc, g, opts.text, color));
  } else {
    if (g) installAP(doc, dict, buildImageAppearance(doc, g, built!));
  }
  return stamp;
}

/** Options for {@link Page.AddFileAttachment}. */
export interface FileAttachmentOptions extends AttachmentOptions {
  /** Annotation rectangle [x1, y1, x2, y2] in PDF user space. */
  rect: [number, number, number, number];
  /** Embedded file name. */
  name: string;
  /** File bytes to embed. */
  bytes: Uint8Array;
  /** Icon key. Default 'PushPin'. */
  icon?: 'PushPin' | 'Paperclip' | 'Graph' | 'Tag';
  /** Also register the file in /Names /EmbeddedFiles so it shows in the
   *  attachments panel (shares one filespec object). Default false. */
  addToCatalog?: boolean;
  /** Optional /Contents note text. */
  contents?: string;
  /** Optional icon color [r, g, b] in 0..1. */
  color?: [number, number, number];
}

/** Create a /FileAttachment annotation on `page` embedding `opts.bytes`. */
export function addFileAttachment(
  doc: Document, page: Page, opts: FileAttachmentOptions,
): FileAttachmentAnnotation {
  if (!(opts.bytes instanceof Uint8Array)) throw new TypeError('file attachment bytes must be a Uint8Array');
  if (typeof opts.name !== 'string' || opts.name === '') throw new RangeError('file attachment name must be a non-empty string');
  const fs = buildFilespec(opts.bytes, opts.name, opts, (o) => doc.allocObject(o));
  const fsRef = doc.allocObject(fs);
  const dict = createAnnotation(doc, page, {
    subtype: 'FileAttachment', rect: opts.rect, color: opts.color, contents: opts.contents,
  });
  dict.set('FS', fsRef);
  dict.set('Name', name(opts.icon ?? 'PushPin'));
  if (opts.addToCatalog) upsertEmbeddedFile(doc, opts.name, fsRef);
  return new FileAttachmentAnnotation(doc, dict);
}

/** Options for the Page.Add{Highlight,Underline,StrikeOut,Squiggly} methods. */
export interface MarkupOptions {
  /** /QuadPoints: 8·n finite numbers (4 corner points per marked quad). */
  quads: number[];
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
  /** /C color, RGB 0..1. Default yellow for highlight, black otherwise. */
  color?: [number, number, number];
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** Validate `quads`: a non-empty list of finite numbers whose length is 8·n. */
function checkQuads(quads: number[]): number[] {
  if (!Array.isArray(quads) || quads.length === 0 || quads.length % 8 !== 0 ||
      !quads.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError('quads must be a non-empty list of finite numbers, length a multiple of 8');
  return [...quads];
}

/** Default /CA for highlights when no opacity is given: translucent enough that
 *  the highlighted text stays legible through the fill. */
const HIGHLIGHT_DEFAULT_OPACITY = 0.4;

/** @internal Build a markup annotation of `subtype`, attach it to the page, set
 *  /QuadPoints + optional /CA, and install an /AP /N drawn by `draw`. Validates
 *  before allocating. `draw` receives form-space quad corners + the resolved color. */
export function addMarkup(
  doc: Document, page: Page, subtype: string, opts: MarkupOptions,
  draw: (qs: QuadCorners[], color: [number, number, number]) => string,
): MarkupAnnotation {
  const quads = checkQuads(opts.quads);
  const defaultColor: [number, number, number] = subtype === 'Highlight' ? [1, 1, 0] : [0, 0, 0];
  const color = opts.color ?? defaultColor;
  if (opts.opacity !== undefined &&
      (typeof opts.opacity !== 'number' || !Number.isFinite(opts.opacity) || opts.opacity < 0 || opts.opacity > 1))
    throw new TypeError('opacity must be in 0..1');

  const { minX, minY, maxX, maxY } = quadsBBox(quads);
  const dict = createAnnotation(doc, page, {
    subtype,
    rect: [minX, minY, maxX, maxY],
    color,
    contents: opts.contents,
    popup: opts.popup,
  });
  // Highlights fill each quad solid, which would hide the underlying text; give
  // them a readable translucent default so they work out of the box. Stroked
  // markups (underline/strikeout/squiggly) sit beside the glyphs, so stay opaque.
  const opacity = opts.opacity ?? (subtype === 'Highlight' ? HIGHLIGHT_DEFAULT_OPACITY : 1);

  const markup = new MarkupAnnotation(doc, dict);
  markup.QuadPoints = quads;
  // Record /CA for any explicit override, and for the translucent highlight default.
  if (opts.opacity !== undefined || opacity < 1) markup.Opacity = opacity;

  const w = maxX - minX, h = maxY - minY;
  if (w > 0 && h > 0) {
    const g: WidgetGeom = { w, h, rotate: 0 };
    const qs = offsetQuads(quads, minX, minY);
    let body = '';
    if (opacity < 1) body += '/GS0 gs\n';
    body += draw(qs, color);
    const stream = buildAppearanceXObject(doc, g, 'Helvetica', AP_FONT_KEY, body);
    if (opacity < 1) {
      const gsDict: PdfDict = new Map<string, PdfObject>([
        ['Type', name('ExtGState')], ['ca', opacity], ['CA', opacity],
      ]);
      (stream.dict.get('Resources') as PdfDict).set(
        'ExtGState', new Map<string, PdfObject>([['GS0', doc.allocObject(gsDict)]]),
      );
    }
    installAP(doc, dict, stream);
  }
  return markup;
}

/** Build and attach a /Highlight markup annotation to `page`. */
export function addHighlight(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation {
  return addMarkup(doc, page, 'Highlight', opts, drawHighlight);
}

/** Build and attach an /Underline markup annotation to `page`. */
export function addUnderline(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation {
  return addMarkup(doc, page, 'Underline', opts, drawUnderline);
}

/** Build and attach a /StrikeOut markup annotation to `page`. */
export function addStrikeOut(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation {
  return addMarkup(doc, page, 'StrikeOut', opts, drawStrikeOut);
}

/** Build and attach a /Squiggly markup annotation to `page`. */
export function addSquiggly(doc: Document, page: Page, opts: MarkupOptions): MarkupAnnotation {
  return addMarkup(doc, page, 'Squiggly', opts, drawSquiggly);
}

/** Validate an optional RGB color; returns a defensive copy or undefined. */
function checkOptColor(key: string, v: [number, number, number] | undefined): [number, number, number] | undefined {
  if (v === undefined) return undefined;
  const c = checkNums(key, v, 3);
  if (c.some((x) => x < 0 || x > 1)) throw new TypeError(`${key} components must be in 0..1`);
  return [c[0], c[1], c[2]];
}

/** Validate an optional border width; default 1. */
function checkOptWidth(v: number | undefined): number {
  if (v === undefined) return 1;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new TypeError('width must be a non-negative finite number');
  return v;
}

/** Validate an optional /CA opacity in 0..1; undefined passes through. */
function checkOptOpacity(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
    throw new TypeError('opacity must be in 0..1');
  return v;
}

/** Validate a /CL callout: 4 or 6 finite numbers; returns a defensive copy. */
function checkCallout(v: number[]): number[] {
  if (!Array.isArray(v) || (v.length !== 4 && v.length !== 6) ||
      !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new TypeError('callout must be 4 or 6 finite numbers');
  return [...v];
}

/** Options for Page.AddSquare / Page.AddCircle. */
export interface SquareCircleOptions {
  rect: [number, number, number, number];
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
  /** Border stroke color /C, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Interior fill color /IC, RGB 0..1. Omitted → no fill. */
  fill?: [number, number, number];
  /** Border width /BS /W. Default 1. */
  width?: number;
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** @internal Shared builder for /Square and /Circle. */
function addSquareCircle(doc: Document, page: Page, subtype: 'Square' | 'Circle', opts: SquareCircleOptions): SquareCircleAnnotation {
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const fill = checkOptColor('fill', opts.fill);
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);

  const dict = createAnnotation(doc, page, { subtype, rect: opts.rect, color, contents: opts.contents, popup: opts.popup });
  const annot = new SquareCircleAnnotation(doc, dict);
  setBorderWidth(dict, width);
  if (fill) annot.InteriorColor = fill;
  if (opacity !== undefined) annot.Opacity = opacity;
  // Record the border half-inset between /Rect and the drawn geometry.
  const half = width / 2;
  dict.set('RD', [half, half, half, half]);

  const g = widgetGeom(doc, dict);
  if (g) {
    const body = subtype === 'Circle' ? drawEllipse(g, color, fill, width) : drawRect(g, color, fill, width);
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
}

/** Build and attach a /Square annotation to `page`. */
export function addSquare(doc: Document, page: Page, opts: SquareCircleOptions): SquareCircleAnnotation {
  return addSquareCircle(doc, page, 'Square', opts);
}

/** Build and attach a /Circle annotation to `page`. */
export function addCircle(doc: Document, page: Page, opts: SquareCircleOptions): SquareCircleAnnotation {
  return addSquareCircle(doc, page, 'Circle', opts);
}

/** Options for Page.AddCaret. */
export interface CaretOptions {
  rect: [number, number, number, number];
  /** /Sy symbol drawn beside the caret. Default 'none'. */
  symbol?: 'none' | 'paragraph';
  /** /C colour, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** /Contents body text. */
  contents?: string;
  /** /T author label. */
  author?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
}

/** Build and attach a /Caret text-insertion annotation to `page`: a filled wedge
 *  marking where text should be inserted, with an optional paragraph sign.
 *  /RD is never written — our caret fills its /Rect, so the difference it would
 *  record is always zero, which is what an absent /RD already means. */
export function addCaret(doc: Document, page: Page, opts: CaretOptions): CaretAnnotation {
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const opacity = checkOptOpacity(opts.opacity);
  const symbol = opts.symbol ?? 'none';
  if (symbol !== 'none' && symbol !== 'paragraph')
    throw new TypeError("symbol must be 'none' or 'paragraph'");
  if (opts.author !== undefined && typeof opts.author !== 'string')
    throw new TypeError('author must be a string');

  const dict = createAnnotation(doc, page, {
    subtype: 'Caret', rect: opts.rect, color, contents: opts.contents, popup: opts.popup,
  });
  const annot = new CaretAnnotation(doc, dict);
  annot.Symbol = symbol;
  if (opts.author !== undefined) annot.Author = opts.author;
  if (opacity !== undefined) annot.Opacity = opacity;

  const g = widgetGeom(doc, dict);
  if (g) installShapeAP(doc, dict, g, caretBody(g, color, symbol), opacity ?? 1);
  return annot;
}

/** Options for Page.AddLine. */
export interface LineOptions {
  /** Endpoints [x1,y1,x2,y2] in user space (sets /L). */
  line: [number, number, number, number];
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
  /** Stroke color /C, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Line width /BS /W. Default 1. */
  width?: number;
  /** Start ending /LE[0]. Default 'None'. */
  startEnding?: LineEnding;
  /** End ending /LE[1]. Default 'None'. */
  endEnding?: LineEnding;
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** Build and attach a /Line annotation to `page`. /Rect is derived from the
 *  endpoint bounding box padded for the line width and any endings. */
export function addLine(doc: Document, page: Page, opts: LineOptions): LineAnnotation {
  const line = checkNums('line', opts.line, 4);
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);
  const start = opts.startEnding ?? 'None';
  const end = opts.endEnding ?? 'None';
  if (!LINE_ENDINGS.has(start) || !LINE_ENDINGS.has(end))
    throw new TypeError('startEnding/endEnding must be a supported ending name');

  const [x1, y1, x2, y2] = line;
  const hasEndings = start !== 'None' || end !== 'None';
  const endingSize = Math.max(8, width * 3);
  const margin = hasEndings ? endingSize : Math.max(width, 1);
  const minX = Math.min(x1, x2) - margin, maxX = Math.max(x1, x2) + margin;
  const minY = Math.min(y1, y2) - margin, maxY = Math.max(y1, y2) + margin;

  const dict = createAnnotation(doc, page, {
    subtype: 'Line', rect: [minX, minY, maxX, maxY], color, contents: opts.contents, popup: opts.popup,
  });
  const annot = new LineAnnotation(doc, dict);
  annot.Line = [x1, y1, x2, y2];
  setBorderWidth(dict, width);
  if (hasEndings) annot.LineEndings = [start, end];
  if (opacity !== undefined) annot.Opacity = opacity;

  const g = widgetGeom(doc, dict);
  if (g) {
    // Endpoints translated into form space (origin at /Rect lower-left).
    const ax = x1 - minX, ay = y1 - minY, bx = x2 - minX, by = y2 - minY;
    let body = `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
    body += `${num(ax)} ${num(ay)} m ${num(bx)} ${num(by)} l S\n`;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    body += drawEnding(ax, ay, -ux, -uy, start, endingSize, color); // start points away from p2
    body += drawEnding(bx, by, ux, uy, end, endingSize, color);     // end points away from p1
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
}

/** Options for Page.AddPolygon. */
export interface PolygonOptions {
  /** Flat vertex list [x1,y1,x2,y2,…] (≥2 points); sets /Vertices. */
  vertices: number[];
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
  /** Border stroke color /C, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Interior fill color /IC, RGB 0..1. Omitted → no fill. */
  fill?: [number, number, number];
  /** Border width /BS /W. Default 1. */
  width?: number;
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** Build and attach a closed /Polygon annotation to `page`. /Rect is the vertex
 *  bounding box padded for the border width. */
export function addPolygon(doc: Document, page: Page, opts: PolygonOptions): PolyAnnotation {
  const vertices = checkVertices('vertices', opts.vertices);
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const fill = checkOptColor('fill', opts.fill);
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);
  const rect = paddedRect(vertices, Math.max(width, 1));

  const dict = createAnnotation(doc, page, {
    subtype: 'Polygon', rect, color, contents: opts.contents, popup: opts.popup,
  });
  const annot = new PolyAnnotation(doc, dict);
  annot.Vertices = vertices;
  setBorderWidth(dict, width);
  if (fill) annot.InteriorColor = fill;
  if (opacity !== undefined) annot.Opacity = opacity;

  const g = widgetGeom(doc, dict);
  if (g) {
    const pts = toFormSpace(vertices, rect[0], rect[1]);
    installShapeAP(doc, dict, g, polyPathBody(pts, true, color, fill, width), opacity ?? 1);
  }
  return annot;
}

/** Options for Page.AddPolyline. */
export interface PolylineOptions {
  /** Flat vertex list [x1,y1,x2,y2,…] (≥2 points); sets /Vertices. */
  vertices: number[];
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
  /** Stroke color /C, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Line width /BS /W. Default 1. */
  width?: number;
  /** Start ending /LE[0]. Default 'None'. */
  startEnding?: LineEnding;
  /** End ending /LE[1]. Default 'None'. */
  endEnding?: LineEnding;
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** Build and attach an open /PolyLine annotation to `page`, with optional end
 *  arrowheads. /Rect is the vertex bounding box padded for width and endings. */
export function addPolyline(doc: Document, page: Page, opts: PolylineOptions): PolyAnnotation {
  const vertices = checkVertices('vertices', opts.vertices);
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);
  const start = opts.startEnding ?? 'None';
  const end = opts.endEnding ?? 'None';
  if (!LINE_ENDINGS.has(start) || !LINE_ENDINGS.has(end))
    throw new TypeError('startEnding/endEnding must be a supported ending name');

  const hasEndings = start !== 'None' || end !== 'None';
  const endingSize = Math.max(8, width * 3);
  const rect = paddedRect(vertices, hasEndings ? endingSize : Math.max(width, 1));

  const dict = createAnnotation(doc, page, {
    subtype: 'PolyLine', rect, color, contents: opts.contents, popup: opts.popup,
  });
  const annot = new PolyAnnotation(doc, dict);
  annot.Vertices = vertices;
  setBorderWidth(dict, width);
  if (hasEndings) annot.LineEndings = [start, end];
  if (opacity !== undefined) annot.Opacity = opacity;

  const g = widgetGeom(doc, dict);
  if (g) {
    const pts = toFormSpace(vertices, rect[0], rect[1]);
    let body = polyPathBody(pts, false, color, undefined, width);
    const n = pts.length;
    // Endings point outward from the path: start away from v1, end away from vprev.
    const [sx, sy] = unitDir(pts[2], pts[3], pts[0], pts[1]);
    body += drawEnding(pts[0], pts[1], sx, sy, start, endingSize, color);
    const [ex, ey] = unitDir(pts[n - 4], pts[n - 3], pts[n - 2], pts[n - 1]);
    body += drawEnding(pts[n - 2], pts[n - 1], ex, ey, end, endingSize, color);
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
}

/** Options for Page.AddInk. */
export interface InkOptions {
  /** Strokes, each a flat point list [x1,y1,x2,y2,…] (≥2 points); sets /InkList. */
  paths: number[][];
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
  /** Stroke color /C, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Line width /BS /W. Default 1. */
  width?: number;
  /** /Contents body text. */
  contents?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
}

/** Build and attach an /Ink annotation to `page`: one or more freehand strokes
 *  (drawn as straight polylines through the points). /Rect is the bounding box
 *  over all points, padded for the line width. */
export function addInk(doc: Document, page: Page, opts: InkOptions): InkAnnotation {
  if (!Array.isArray(opts.paths) || opts.paths.length === 0)
    throw new TypeError('paths must be a non-empty array of strokes');
  const paths = opts.paths.map((s) => checkVertices('ink stroke', s));
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);
  const rect = paddedRect(paths.flat(), Math.max(width, 1));

  const dict = createAnnotation(doc, page, {
    subtype: 'Ink', rect, color, contents: opts.contents, popup: opts.popup,
  });
  const annot = new InkAnnotation(doc, dict);
  annot.InkList = paths;
  setBorderWidth(dict, width);
  if (opacity !== undefined) annot.Opacity = opacity;

  const g = widgetGeom(doc, dict);
  if (g) {
    let body = `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width)} w\n`;
    for (const stroke of paths) {
      const pts = toFormSpace(stroke, rect[0], rect[1]);
      body += `${num(pts[0])} ${num(pts[1])} m `;
      for (let i = 2; i < pts.length; i += 2) body += `${num(pts[i])} ${num(pts[i + 1])} l `;
      body += 'S\n';
    }
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
}

/** Options for Page.AddFreeText. */
export interface FreeTextOptions {
  rect: [number, number, number, number];
  /** Displayed text (required, non-empty). */
  contents: string;
  /** /DA font size. Default 12. */
  fontSize?: number;
  /** /DA text fill color, RGB 0..1. Default black [0,0,0]. */
  textColor?: [number, number, number];
  /** /Q alignment. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Border /C color, RGB 0..1. Default black [0,0,0]. */
  color?: [number, number, number];
  /** Box interior /IC fill, RGB 0..1. Omitted → no fill. */
  fill?: [number, number, number];
  /** Border /BS /W width. Default 1. */
  width?: number;
  /** /CL callout leader: 4 or 6 numbers in page space (first point is the tip). */
  callout?: number[];
  /** /LE ending at the callout tip. Default 'OpenArrow' when a callout is set. */
  calloutEnding?: LineEnding;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
}

/** Build and attach a /FreeText annotation to `page`: text drawn on the page,
 *  optionally with a /CL callout leader (arrowhead at its first point). /Rect is
 *  the text box, or its padded union with the callout points when a callout is
 *  set (the text-box padding recorded in /RD). */
export function addFreeText(doc: Document, page: Page, opts: FreeTextOptions): FreeTextAnnotation {
  if (typeof opts.contents !== 'string' || opts.contents.length === 0)
    throw new TypeError('contents must be a non-empty string');
  const rect = checkNums('rect', opts.rect, 4);
  const fontSize = opts.fontSize ?? 12;
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const textColor = checkOptColor('textColor', opts.textColor) ?? [0, 0, 0];
  const color = checkOptColor('color', opts.color) ?? [0, 0, 0];
  const fill = checkOptColor('fill', opts.fill);
  const width = checkOptWidth(opts.width);
  const opacity = checkOptOpacity(opts.opacity);
  const align = opts.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  const callout = opts.callout !== undefined ? checkCallout(opts.callout) : undefined;
  const calloutEnding = callout ? (opts.calloutEnding ?? 'OpenArrow') : opts.calloutEnding;
  if (calloutEnding !== undefined && !LINE_ENDINGS.has(calloutEnding))
    throw new TypeError('calloutEnding must be a supported ending name');

  // Text box in page space (normalized min/max).
  const bx0 = Math.min(rect[0], rect[2]), by0 = Math.min(rect[1], rect[3]);
  const bx1 = Math.max(rect[0], rect[2]), by1 = Math.max(rect[1], rect[3]);

  // /Rect = text box, or its union with the callout points (padded) when set.
  let annotRect: [number, number, number, number] = [bx0, by0, bx1, by1];
  if (callout) {
    const endingSize = Math.max(8, width * 3);
    const margin = Math.max(width, endingSize);
    let mnX = bx0, mnY = by0, mxX = bx1, mxY = by1;
    for (let i = 0; i < callout.length; i += 2) {
      mnX = Math.min(mnX, callout[i] - margin); mxX = Math.max(mxX, callout[i] + margin);
      mnY = Math.min(mnY, callout[i + 1] - margin); mxY = Math.max(mxY, callout[i + 1] + margin);
    }
    annotRect = [mnX, mnY, mxX, mxY];
  }

  const dict = createAnnotation(doc, page, {
    subtype: 'FreeText', rect: annotRect, color, contents: opts.contents, popup: opts.popup,
  });
  const annot = new FreeTextAnnotation(doc, dict);
  dict.set('DA', buildDA('Helv', fontSize, textColor));
  annot.Alignment = align;
  setBorderWidth(dict, width);
  if (fill) annot.InteriorColor = fill;
  if (opacity !== undefined) annot.Opacity = opacity;

  if (callout) {
    annot.CalloutLine = callout;
    if (calloutEnding) annot.CalloutEnding = calloutEnding;
    annot.Intent = 'FreeTextCallout';
    // /RD padding from /Rect to the text box [left, top, right, bottom].
    dict.set('RD', [bx0 - annotRect[0], annotRect[3] - by1, annotRect[2] - bx1, by0 - annotRect[1]]);
  } else {
    const half = width / 2;
    dict.set('RD', [half, half, half, half]);
  }

  const g = widgetGeom(doc, dict);
  if (g) {
    const boxW = bx1 - bx0, boxH = by1 - by0;
    let body: string;
    if (callout) {
      const ox = bx0 - annotRect[0], oy = by0 - annotRect[1]; // text-box offset in BBox
      body = `q 1 0 0 1 ${num(ox)} ${num(oy)} cm\n` +
        freeTextBoxBody(boxW, boxH, opts.contents, fontSize, textColor, align, color, fill, width) + `\nQ\n`;
      // Leader polyline (page → BBox space) stroked, plus a tip arrowhead.
      const p = callout.map((v, i) => (i % 2 === 0 ? v - annotRect[0] : v - annotRect[1]));
      body += `${num(color[0])} ${num(color[1])} ${num(color[2])} RG\n${num(width || 1)} w\n`;
      body += `${num(p[0])} ${num(p[1])} m `;
      for (let i = 2; i < p.length; i += 2) body += `${num(p[i])} ${num(p[i + 1])} l `;
      body += `S\n`;
      if (calloutEnding && calloutEnding !== 'None') {
        const len = Math.hypot(p[0] - p[2], p[1] - p[3]) || 1;
        const dx = (p[0] - p[2]) / len, dy = (p[1] - p[3]) / len; // outward at the tip
        body += drawEnding(p[0], p[1], dx, dy, calloutEnding, Math.max(8, width * 3), color);
      }
    } else {
      body = freeTextBoxBody(g.w, g.h, opts.contents, fontSize, textColor, align, color, fill, width);
    }
    installShapeAP(doc, dict, g, body, opacity ?? 1);
  }
  return annot;
}

/** Options for Page.AddRedact. Exactly one of `quads` or `rect`.
 *  (Named distinctly from `RedactOptions` in redact.ts, which configures the
 *  unrelated destructive `Redact`.) */
export interface RedactAnnotationOptions {
  /** /QuadPoints: 8·n finite numbers (4 corner points per marked quad). */
  quads?: number[];
  /** Single-region convenience, expanded to one quad. */
  rect?: [number, number, number, number];
  /** /C colour of the pending-mark outline, RGB 0..1. Default red [1,0,0]. */
  color?: [number, number, number];
  /** /IC colour painted over the region on apply, RGB 0..1. Default black. */
  fill?: [number, number, number];
  /** /OverlayText drawn over the filled region on apply. */
  overlayText?: string;
  /** /Repeat — tile the overlay text to fill the region. Default false. */
  repeat?: boolean;
  /** /Q overlay-text justification. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** /DA overlay-text font size. Default 12. */
  fontSize?: number;
  /** /DA overlay-text colour, RGB 0..1. Default white [1,1,1]. */
  textColor?: [number, number, number];
  /** /Contents body text. */
  contents?: string;
  /** /T author label. */
  author?: string;
  /** /CA constant opacity, 0..1. */
  opacity?: number;
  /** Auto-attach a companion /Popup. */
  popup?: PopupSpec;
}

/** @internal One /QuadPoints quad covering `r`, in the TL, TR, BL, BR order
 *  PDF 32000-1 §12.5.6.10 specifies. Shared with markRedactText, which turns
 *  each search hit's line box into a quad. */
export function rectToQuad(r: [number, number, number, number]): number[] {
  const x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3]);
  const x1 = Math.max(r[0], r[2]), y1 = Math.max(r[1], r[3]);
  return [x0, y1, x1, y1, x0, y0, x1, y0];
}

/** Build and attach a /Redact annotation to `page`. This *marks* the region and
 *  removes nothing; `Page.ApplyRedactions` is what destroys the content. The
 *  installed /AP outlines each quad rather than filling it, so an unapplied mark
 *  never renders like a finished redaction. */
export function addRedact(doc: Document, page: Page, opts: RedactAnnotationOptions): RedactAnnotation {
  const hasQuads = opts.quads !== undefined, hasRect = opts.rect !== undefined;
  if (hasQuads === hasRect)
    throw new TypeError('AddRedact requires exactly one of quads or rect');
  const quads = hasQuads
    ? checkQuads(opts.quads as number[])
    : rectToQuad(checkNums('rect', opts.rect as number[], 4) as [number, number, number, number]);

  const color = checkOptColor('color', opts.color) ?? [1, 0, 0];
  const fill = checkOptColor('fill', opts.fill) ?? [0, 0, 0];
  const textColor = checkOptColor('textColor', opts.textColor) ?? [1, 1, 1];
  const opacity = checkOptOpacity(opts.opacity);
  const fontSize = opts.fontSize ?? 12;
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const align = opts.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  if (opts.overlayText !== undefined && typeof opts.overlayText !== 'string')
    throw new TypeError('overlayText must be a string');
  if (opts.repeat !== undefined && typeof opts.repeat !== 'boolean')
    throw new TypeError('repeat must be a boolean');
  if (opts.author !== undefined && typeof opts.author !== 'string')
    throw new TypeError('author must be a string');

  const { minX, minY, maxX, maxY } = quadsBBox(quads);
  const dict = createAnnotation(doc, page, {
    subtype: 'Redact',
    rect: [minX, minY, maxX, maxY],
    color,
    contents: opts.contents,
    popup: opts.popup,
  });
  const annot = new RedactAnnotation(doc, dict);
  annot.QuadPoints = quads;
  annot.InteriorColor = fill;
  annot.Alignment = align;
  dict.set('DA', buildDA('Helv', fontSize, textColor));
  if (opts.overlayText !== undefined) annot.OverlayText = opts.overlayText;
  if (opts.repeat) annot.Repeat = true;
  if (opts.author !== undefined) annot.Author = opts.author;
  if (opacity !== undefined) annot.Opacity = opacity;

  const w = maxX - minX, h = maxY - minY;
  if (w > 0 && h > 0) {
    const g: WidgetGeom = { w, h, rotate: 0 };
    installShapeAP(doc, dict, g, redactMarkBody(offsetQuads(quads, minX, minY), color), opacity ?? 1);
  }
  return annot;
}

/** Options for Page.AddPopup. */
export interface PopupOptions extends PopupSpec {
  /** The markup annotation this popup belongs to (an attached, indirect annot). */
  parent: Annotation | PdfDict;
}

/** Default popup rect: a ~200×100 box beside the parent's /Rect (right, top). */
function defaultPopupRect(doc: Document, parentDict: PdfDict): [number, number, number, number] {
  const pr = numArray(doc, parentDict.get('Rect'), 4) ?? [0, 0, 0, 0];
  const x1 = Math.max(pr[0], pr[2]), yTop = Math.max(pr[1], pr[3]);
  return [x1, yTop - 100, x1 + 200, yTop];
}

/** Find the /Annots ref that resolves to `dict` on `page`; throws when `dict`
 *  is not an indirect annotation on this page. */
function refForAnnot(doc: Document, page: Page, dict: PdfDict): PdfRef {
  const arr = doc.resolve(page.Dict.get('Annots'));
  if (isArray(arr)) for (const e of arr) { if (isRef(e) && doc.resolve(e) === dict) return e; }
  throw new UnsupportedFeatureError('popup parent must be an indirect annotation on this page');
}

/** @internal Build a /Popup dict, attach it to the page, link it to its parent
 *  (/Parent → parentRef, parent /Popup → new popup). Validates rect first. */
function createPopup(
  doc: Document, page: Page, parentRef: PdfRef, spec: PopupSpec, parentDict: PdfDict,
): PopupAnnotation {
  const rect = spec.rect !== undefined ? checkNums('popup rect', spec.rect, 4) : defaultPopupRect(doc, parentDict);
  const dict: PdfDict = new Map<string, PdfObject>();
  dict.set('Type', name('Annot'));
  dict.set('Subtype', name('Popup'));
  dict.set('Rect', rect);
  dict.set('Parent', parentRef);
  if (spec.open) dict.set('Open', true);
  const r = doc.allocObject(dict);
  ownAnnots(doc, page).push(r);
  parentDict.set('Popup', r);
  return new PopupAnnotation(doc, dict);
}

/** Build and attach a /Popup annotation bound to `opts.parent`. */
export function addPopup(doc: Document, page: Page, opts: PopupOptions): PopupAnnotation {
  const parentDict = opts.parent instanceof Annotation ? opts.parent.Dict : opts.parent;
  if (!isDict(parentDict)) throw new TypeError('parent must be an annotation dict');
  const parentRef = refForAnnot(doc, page, parentDict);
  return createPopup(doc, page, parentRef, { rect: opts.rect, open: opts.open }, parentDict);
}

/** Options for Page.AddLink. */
export interface LinkOptions {
  rect: [number, number, number, number];
  /** The link's action. Any modelled action type; a link most often carries a
   *  GoTo or URI, but a submit or reset action is equally legal. */
  action: PdfAction;
  /** /Border width in points; default 0 (invisible). */
  border?: number;
}

/** Build and attach a /Link annotation to `page`; returns its LinkAnnotation
 *  handle. Validates the action/border and (for GoTo) resolves the target page
 *  ref before mutating the page. */
export function addLink(doc: Document, page: Page, opts: LinkOptions): LinkAnnotation {
  const action = opts.action;
  const border = opts.border ?? 0;
  if (typeof border !== 'number' || !Number.isFinite(border) || border < 0)
    throw new TypeError('border must be a non-negative finite number');

  // Validates before anything is allocated, exactly as the inline copy did.
  const aDict = encodeAction(doc, action);

  const dict = createAnnotation(doc, page, { subtype: 'Link', rect: opts.rect });
  dict.set('A', aDict);
  dict.set('Border', [0, 0, border]);
  return new LinkAnnotation(doc, dict);
}
