import type { Document } from './document.js';
import type { FieldType } from './formfield.js';
import {
  PdfObject, PdfDict, PdfStream, isDict, isArray, isString, isName, name,
} from './types.js';
import { num } from './pagecontent.js';
import { enc, serializeString } from './serialize.js';
import { encodeWinAnsi } from './encoding.js';
import { measure, type StdFont } from './metrics.js';
import { resolveDA, type ResolvedDA } from './da.js';
import { decodePdfText } from './metadata.js';
import { displayOf, parseOptions, type NormalizedOption } from './choiceopt.js';

/** Internal horizontal padding inside the box, in points. */
const PAD = 2;

import { FF_MULTILINE, FF_COMB, FF_COMBO, FF_PASSWORD } from './fieldflags.js';

// ZapfDingbats glyphs used for synthesized button marks.
const ZADB_CHECK = '4';  // a check mark
const ZADB_CIRCLE = 'l'; // a filled circle (radio)

/** Normalized widget geometry: the *layout* box every body composes into, plus
 *  the quarter-turn rotation from /MK /R that maps it onto the widget /Rect.
 *
 *  Under a quarter turn the layout box is the /Rect transposed — a 200x50 field
 *  turned 90° is written as 50 wide and 200 tall, and the /Matrix rotates it
 *  back. Handing bodies the /Rect dimensions instead makes them wrap and centre
 *  against the wrong edges, and leaves a /BBox whose transform no longer covers
 *  the /Rect, so the viewer scales the whole appearance to fit. */
export interface WidgetGeom { w: number; h: number; rotate: 0 | 90 | 180 | 270 }

function nums(doc: Document, o: PdfObject | undefined, n: number): number[] | undefined {
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

/** Box geometry from a widget /Rect (normalized, absolute) and /MK /R rotation;
 *  undefined when /Rect is missing or has (near-)zero area. */
export function widgetGeom(doc: Document, widget: PdfDict): WidgetGeom | undefined {
  const r = nums(doc, widget.get('Rect'), 4);
  if (!r) return undefined;
  const w = Math.abs(r[2] - r[0]);
  const h = Math.abs(r[3] - r[1]);
  if (w < 1e-3 || h < 1e-3) return undefined;
  let rotate: 0 | 90 | 180 | 270 = 0;
  const mk = doc.resolve(widget.get('MK'));
  if (isDict(mk)) {
    const rr = doc.resolve((mk as PdfDict).get('R'));
    if (rr === 90 || rr === 180 || rr === 270) rotate = rr;
  }
  const quarter = rotate === 90 || rotate === 270;
  return { w: quarter ? h : w, h: quarter ? w : h, rotate };
}

/** A /Resources dict carrying a single Type1 font under `key`, whose /BaseFont is
 *  the resolved Standard-14 `std`. */
export function fontResources(doc: Document, std: StdFont, key: string): PdfDict {
  const fontDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type1')],
    ['BaseFont', name(std)],
    ['Encoding', name('WinAnsiEncoding')],
  ]);
  const fonts: PdfDict = new Map([[key, doc.allocObject(fontDict)]]);
  return new Map<string, PdfObject>([['Font', fonts]]);
}

/** An array of numbers, or undefined when absent or empty. Used for /MK colours
 *  (where an empty array is the specification's "transparent") and for the
 *  /BS /D dash pattern. */
function numArray(doc: Document, o: PdfObject | undefined): number[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a)) return undefined;
  const out: number[] = [];
  for (const e of a) { const v = doc.resolve(e); if (typeof v === 'number') out.push(v); }
  return out.length ? out : undefined;
}

function setColorOp(c: number[], stroke: boolean): string {
  if (c.length === 1) return `${num(c[0])} ${stroke ? 'G' : 'g'}`;
  if (c.length === 4)
    return `${num(c[0])} ${num(c[1])} ${num(c[2])} ${num(c[3])} ${stroke ? 'K' : 'k'}`;
  return `${num(c[0] ?? 0)} ${num(c[1] ?? 0)} ${num(c[2] ?? 0)} ${stroke ? 'RG' : 'rg'}`;
}

/** Scale a fill colour toward black by `k` (k < 1 darkens). Grey and RGB scale
 *  their components; CMYK instead raises the black channel, because scaling ink
 *  values down would *lighten* it. */
function darkenColor(c: number[], k: number): number[] {
  if (k === 1) return c;
  if (c.length === 4) return [c[0], c[1], c[2], Math.min(1, c[3] + (1 - k))];
  return c.map((v) => Math.max(0, Math.min(1, v * k)));
}

/** Highlight and shadow greys for a 3-D border's two bands. */
const BEVEL_LIGHT = 1;
const BEVEL_DARK = 0.5;

/** /BS as the three things a border needs, with the specification's defaults
 *  (width 1, style Solid, dash [3]) for every key the widget omits. */
function borderSpec(doc: Document, widget: PdfDict): { w: number; s: string; dash: number[] } {
  let w = 1, s = 'S', dash = [3];
  const bs = doc.resolve(widget.get('BS'));
  if (isDict(bs)) {
    const wv = doc.resolve((bs as PdfDict).get('W'));
    if (typeof wv === 'number') w = wv;
    const sv = doc.resolve((bs as PdfDict).get('S'));
    if (isName(sv)) s = sv.name;
    const dv = numArray(doc, (bs as PdfDict).get('D'));
    if (dv) dash = dv;
  }
  return { w, s, dash };
}

/** The two L-shaped bands of a 3-D border, filled in the ring between inset
 *  `bw` and inset `2*bw` — just inside the /BC stroke. `raised` puts the
 *  highlight on the top-left (Beveled); false swaps them (Inset).
 *
 *  Two separate fills rather than one path: the Ls abut along their diagonals
 *  but never overlap, so no winding rule has to reconcile them. */
function bevelOps(w: number, h: number, bw: number, raised: boolean): string {
  const a = bw, b = bw * 2;
  const poly = (pts: Array<[number, number]>): string =>
    pts.map(([x, y], i) => `${num(x)} ${num(y)} ${i === 0 ? 'm' : 'l'}`).join(' ') + ' h f\n';
  const upper = poly([[a, a], [a, h - a], [w - a, h - a], [w - b, h - b], [b, h - b], [b, b]]);
  const lower = poly([[a, a], [b, b], [w - b, b], [w - b, h - b], [w - a, h - a], [w - a, a]]);
  const light = `${num(BEVEL_LIGHT)} g\n`;
  const dark = `${num(BEVEL_DARK)} g\n`;
  return raised ? light + upper + dark + lower : dark + upper + light + lower;
}

/** Content ops painting the widget's /MK background (/BG) and border (/BC), plus
 *  a border inset for text layout. Empty when there is no /MK.
 *
 *  `darken` (default 1) scales the background toward black; a push button's
 *  pressed state uses it. The border is deliberately not darkened — a pressed
 *  button darkens its face, not its outline. */
export function mkOps(
  doc: Document, widget: PdfDict, g: WidgetGeom, darken = 1,
): { ops: string; inset: number } {
  const mk = doc.resolve(widget.get('MK'));
  if (!isDict(mk)) return { ops: '', inset: 0 };

  let ops = '';
  const bg = numArray(doc, (mk as PdfDict).get('BG'));
  if (bg) ops += `${setColorOp(darkenColor(bg, darken), false)} 0 0 ${num(g.w)} ${num(g.h)} re f\n`;

  const bc = numArray(doc, (mk as PdfDict).get('BC'));
  if (!bc) return { ops, inset: 0 };
  const { w: bw, s, dash } = borderSpec(doc, widget);
  if (bw <= 0) return { ops, inset: 0 };

  const half = bw / 2;
  const pen = `${setColorOp(bc, true)} ${num(bw)} w `;
  const box = `${num(half)} ${num(half)} ${num(g.w - bw)} ${num(g.h - bw)} re S\n`;

  switch (s) {
    case 'U':
      // Only a bottom edge, so there is no side or top border for text to avoid.
      ops += `${pen}${num(0)} ${num(half)} m ${num(g.w)} ${num(half)} l S\n`;
      return { ops, inset: 0 };
    case 'D':
      ops += `${pen}[${dash.map((d) => num(d)).join(' ')}] 0 d ${box}`;
      return { ops, inset: bw };
    case 'B':
    case 'I':
      // The bevel band sits inside the stroke and eats another bw of the box,
      // so text must clear both or its glyphs land on the highlight.
      ops += pen + box + bevelOps(g.w, g.h, bw, s === 'B');
      return { ops, inset: bw * 2 };
    default:
      // 'S' and anything unrecognised: the specification's default.
      ops += pen + box;
      return { ops, inset: bw };
  }
}

/** Clip path (`re W n`) limiting painting to the border-inset content rect, so
 *  long values are hard-clipped to the box rather than relying on layout insets.
 *  Emit this *after* the /MK background+border ops so the border is never
 *  clipped. Falls back to the full box when the border would consume it. */
export function clipOps(g: WidgetGeom, inset: number): string {
  let x = inset, y = inset, w = g.w - 2 * inset, h = g.h - 2 * inset;
  if (w <= 0 || h <= 0) { x = 0; y = 0; w = g.w; h = g.h; }
  return `${num(x)} ${num(y)} ${num(w)} ${num(h)} re W n\n`;
}

/** The /Matrix that turns the layout box onto the widget rect. The translation
 *  is what puts the rotated box back at the origin: a quarter turn sweeps the
 *  layout box into negative x (90°) or negative y (270°), so it is shifted by
 *  the box extent that ends up spanning that axis. */
function matrixFor(g: WidgetGeom): number[] {
  switch (g.rotate) {
    case 90: return [0, 1, -1, 0, g.h, 0];
    case 180: return [-1, 0, 0, -1, g.w, g.h];
    case 270: return [0, -1, 1, 0, 0, g.w];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

/** Assemble a /Form XObject appearance stream. `body` is the already-composed
 *  content (callers pass `mk.ops + typeBody`); it is wrapped in q/Q. */
export function buildAppearanceXObject(
  doc: Document, g: WidgetGeom, std: StdFont, fontKey: string, body: string,
): PdfStream {
  const content = `q\n${body}\nQ`;
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [0, 0, g.w, g.h]],
    ['Matrix', matrixFor(g)],
    ['Resources', fontResources(doc, std, fontKey)],
  ]);
  return { kind: 'stream', dict, raw: enc(content) };
}

/** Install `stream` as the widget's single normal appearance (/AP /N). */
export function installAP(doc: Document, widget: PdfDict, stream: PdfStream): void {
  const ref = doc.allocObject(stream);
  widget.set('AP', new Map<string, PdfObject>([['N', ref]]));
}

/** Install `stream` as the widget's normal appearance for state `state`
 *  (/AP /N /<state>), creating the /AP and /N dicts as needed. */
export function installAPState(doc: Document, widget: PdfDict, state: string, stream: PdfStream): void {
  const ref = doc.allocObject(stream);
  let ap = doc.resolve(widget.get('AP'));
  if (!isDict(ap)) { ap = new Map<string, PdfObject>(); widget.set('AP', ap); }
  let n = doc.resolve((ap as PdfDict).get('N'));
  if (!isDict(n)) { n = new Map<string, PdfObject>(); (ap as PdfDict).set('N', n); }
  (n as PdfDict).set(state, ref);
}

/** Largest font size fitting both box height (~0.85·h, capped at 12) and width. */
function autoSize(text: Uint8Array, std: StdFont, boxW: number, boxH: number): number {
  let size = Math.min(12, boxH * 0.85);
  const avail = boxW - 2 * PAD;
  const w = measure(std, text, size);
  if (w > avail && w > 0) size = Math.max(4, (size * avail) / w);
  return size;
}

/** Baseline y that vertically centers a line of `size` within the box. */
function centeredBaseline(boxH: number, size: number, inset: number): number {
  const y = (boxH - size) / 2 + size * 0.2;
  return Math.max(inset + 1, y);
}

function singleLineText(text: string, da: ResolvedDA, g: WidgetGeom, q: number, inset: number): string {
  const bytes = encodeWinAnsi(text);
  const size = da.size > 0 ? da.size : autoSize(bytes, da.std, g.w, g.h);
  const tw = measure(da.std, bytes, size);
  let x = PAD + inset;
  if (q === 1) x = inset + (g.w - 2 * inset - tw) / 2;
  else if (q === 2) x = g.w - inset - PAD - tw;
  if (x < inset + PAD) x = inset + PAD;
  const y = centeredBaseline(g.h, size, inset);
  const [r, gg, b] = da.color;
  return `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n` +
    `${num(x)} ${num(y)} Td\n${serializeString(bytes)} Tj\nET`;
}

/** Greedy word-wrap: split `words` into lines no wider than `maxW` at `size`. */
function wrapLines(words: string[], std: StdFont, size: number, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    if (cur === '' || measure(std, encodeWinAnsi(trial), size) <= maxW) cur = trial;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Body ops for wrapped, aligned text in a box, top-anchored. `inset` is a
 *  border inset applied on all sides; alignment positions each line by measure.
 *
 *  `fontKey` is the /Resources /Font name the `Tf` operator will reference, and
 *  is required rather than defaulted: this function is the one text body shared
 *  across the field and annotation appearance paths, which register different
 *  keys. It hardcoded the field path's /Helv and its only caller is on the
 *  annotation path, so every FreeText appearance named a font its own form did
 *  not contain (bug cu3b). A default would let that happen again silently. */
export function wrapTextBody(
  text: string, std: StdFont, size: number, color: [number, number, number],
  boxW: number, boxH: number, inset: number, align: 'left' | 'center' | 'right',
  fontKey: string,
): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const maxW = boxW - 2 * (PAD + inset);
  const leading = size * 1.15;
  const lines = wrapLines(words, std, size, maxW);
  const [r, g, b] = color;
  const top = boxH - inset - PAD - size * 0.8;
  let s = `BT\n/${fontKey} ${num(size)} Tf\n${num(r)} ${num(g)} ${num(b)} rg\n`;
  let prevX = 0, prevY = 0;
  lines.forEach((ln, i) => {
    const bytes = encodeWinAnsi(ln);
    const tw = measure(std, bytes, size);
    let x = PAD + inset;
    if (align === 'center') x = inset + (boxW - 2 * inset - tw) / 2;
    else if (align === 'right') x = boxW - inset - PAD - tw;
    if (x < inset + PAD) x = inset + PAD;
    const y = top - i * leading;
    s += `${num(x - prevX)} ${num(y - prevY)} Td\n${serializeString(bytes)} Tj\n`;
    prevX = x; prevY = y;
  });
  return s + 'ET';
}

function multilineText(text: string, da: ResolvedDA, g: WidgetGeom, inset: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const maxW = g.w - 2 * (PAD + inset);
  let size = da.size > 0 ? da.size : 12;
  for (;;) {
    const leading = size * 1.15;
    const lines = wrapLines(words, da.std, size, maxW);
    if (lines.length * leading <= g.h - 2 * inset || size <= 4) {
      const [r, gg, b] = da.color;
      const top = g.h - inset - PAD - size * 0.8;
      let s = `BT\n/Helv ${num(size)} Tf\n${num(leading)} TL\n` +
        `${num(r)} ${num(gg)} ${num(b)} rg\n${num(PAD + inset)} ${num(top)} Td\n`;
      lines.forEach((ln, i) => {
        if (i > 0) s += 'T*\n';
        s += `${serializeString(encodeWinAnsi(ln))} Tj\n`;
      });
      return s + 'ET';
    }
    size = Math.max(4, size - 0.5);
  }
}

function combText(text: string, da: ResolvedDA, g: WidgetGeom, maxLen: number, inset: number): string {
  const chars = [...text].slice(0, maxLen);
  const cellW = (g.w - 2 * inset) / maxLen;
  const size = da.size > 0 ? da.size : Math.min(g.h * 0.7, cellW * 0.9);
  const [r, gg, b] = da.color;
  const y = centeredBaseline(g.h, size, inset);
  let s = `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n`;
  let prevX = 0;
  chars.forEach((ch, i) => {
    const bytes = encodeWinAnsi(ch);
    const cw = measure(da.std, bytes, size);
    const x = inset + cellW * (i + 0.5) - cw / 2; // center glyph in its cell
    const dx = x - prevX;
    const dy = i === 0 ? y : 0;
    s += `${num(dx)} ${num(dy)} Td\n${serializeString(bytes)} Tj\n`;
    prevX = x;
  });
  return s + 'ET';
}

function qOf(doc: Document, fieldDict: PdfDict, acroForm: PdfDict): number {
  const q = doc.resolve(fieldDict.get('Q'));
  if (typeof q === 'number') return q;
  const aq = doc.resolve(acroForm.get('Q'));
  return typeof aq === 'number' ? aq : 0;
}

function textOf(value: PdfObject): string {
  if (isString(value)) return decodePdfText(value.bytes);
  if (isName(value)) return value.name;
  return '';
}

/** A password field must never paint its value. One WinAnsi bullet (0x95) per
 *  character, counted by code point so an astral character masks as one bullet
 *  rather than two. Masking here rather than at the call sites means the read
 *  path gets it too: GenerateAppearances and FlattenForm both route through
 *  generateFieldAppearance, and flattening previously baked the plaintext into
 *  permanent page content. */
function maskIfPassword(text: string, ff: number): string {
  return (ff & FF_PASSWORD) ? '•'.repeat([...text].length) : text;
}

function hasNStates(doc: Document, widget: PdfDict): boolean {
  const ap = doc.resolve(widget.get('AP'));
  if (!isDict(ap)) return false;
  const n = doc.resolve((ap as PdfDict).get('N'));
  return isDict(n) && (n as PdfDict).size > 0;
}

/** A /Resources dict carrying the ZapfDingbats font under /ZaDb (for button marks). */
function zapfResources(doc: Document): PdfObject {
  const fontDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('ZapfDingbats')],
  ]);
  return new Map<string, PdfObject>([['Font', new Map([['ZaDb', doc.allocObject(fontDict)]])]]);
}

/** Body that draws a ZapfDingbats glyph centered in the box, in `color`. */
function glyphBody(glyph: string, color: [number, number, number]): (g: WidgetGeom) => string {
  return (g: WidgetGeom) => {
    const size = Math.min(g.w, g.h) * 0.8;
    const bytes = encodeWinAnsi(glyph);
    const w = measure('ZapfDingbats', bytes, size);
    const x = (g.w - w) / 2;
    const y = (g.h - size) / 2 + size * 0.2;
    const [r, gg, b] = color;
    return `BT\n/ZaDb ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n` +
      `${num(x)} ${num(y)} Td\n${serializeString(bytes)} Tj\nET`;
  };
}

/** The state name to synthesize for a button's "on" appearance. Chosen so the
 *  result matches whatever the form setters write to /AS: prefer the widget's
 *  current /AS, then a per-widget /Opt export value, then the field /V, and
 *  finally 'Yes' (the setter's own fallback). Off-state is always 'Off'. */
export function synthOnState(
  doc: Document, widget: PdfDict, fieldDict: PdfDict, widgetIndex: number, value: PdfObject,
): string {
  const as = doc.resolve(widget.get('AS'));
  if (isName(as) && as.name !== 'Off') return as.name;
  const opt = doc.resolve(fieldDict.get('Opt'));
  if (isArray(opt)) {
    const e = doc.resolve(opt[widgetIndex]);
    if (isString(e)) { const s = decodePdfText(e.bytes); if (s) return s; }
  }
  if (isName(value) && value.name !== 'Off') return value.name;
  return 'Yes';
}

/** Build and install a button widget's two normal appearances: `onState` and
 *  'Off'. No-op when the widget has no usable geometry.
 *
 *  Separated from generateFieldAppearance so creation can name the on-state
 *  outright — synthOnState exists to *guess* it for documents we did not
 *  author, and that guess defaults to 'Yes'.
 *
 *  `da` supplies both the mark's colour and the off stream's /Helv face. It is
 *  required rather than defaulted: a defaulted face silently disagreed with the
 *  field's real /DA. */
export function buildButtonAP(
  doc: Document, widget: PdfDict, onState: string,
  kind: 'checkbox' | 'radio', da: ResolvedDA,
): void {
  const g = widgetGeom(doc, widget);
  if (!g) return;
  const mk = mkOps(doc, widget, g);
  const glyph = kind === 'radio' ? ZADB_CIRCLE : ZADB_CHECK;
  const onStream = buildAppearanceXObject(
    doc, g, da.std, 'Helv', mk.ops + glyphBody(glyph, da.color)(g),
  );
  (onStream.dict.get('Resources') as PdfDict).set(
    'Font', (zapfResources(doc) as PdfDict).get('Font')!,
  );
  const offStream = buildAppearanceXObject(doc, g, da.std, 'Helv', mk.ops);
  installAPState(doc, widget, onState, onStream);
  installAPState(doc, widget, 'Off', offStream);
}

/** /V as a list of strings: one entry for a single value, one per element for a
 *  multi-select list box's array. `textOf` returns '' for an array, which is
 *  why this exists — a multi-select selection would otherwise match nothing. */
function valueStrings(doc: Document, value: PdfObject): string[] {
  if (isArray(value)) {
    const out: string[] = [];
    for (const e of value) {
      const r = doc.resolve(e);
      if (isString(r)) out.push(decodePdfText(r.bytes));
    }
    return out;
  }
  const s = textOf(value);
  return s ? [s] : [];
}

/** Zero-based /Opt indices to highlight: /I when present, else the entries
 *  matching the value. Export first, then display — /V holds the export, and
 *  Field.setChoice deletes /I on every write, so this fallback is the normal
 *  path rather than an edge case. */
function selectedIndices(
  doc: Document, fieldDict: PdfDict, entries: NormalizedOption[], value: PdfObject,
): Set<number> {
  const sel = new Set<number>();
  const iArr = doc.resolve(fieldDict.get('I'));
  if (isArray(iArr)) {
    for (const e of iArr) { const v = doc.resolve(e); if (typeof v === 'number') sel.add(v); }
    if (sel.size > 0) return sel;
  }
  for (const want of valueStrings(doc, value)) {
    let idx = entries.findIndex((e) => e.export === want);
    if (idx < 0) idx = entries.findIndex((e) => displayOf(e) === want);
    if (idx >= 0) sel.add(idx);
  }
  return sel;
}

function listBox(
  doc: Document, fieldDict: PdfDict, da: ResolvedDA, g: WidgetGeom, inset: number,
  value: PdfObject, entries: NormalizedOption[],
): string {
  const labels = entries.map(displayOf);
  const size = da.size > 0 ? da.size : 12;
  const line = size * 1.15;
  const tiRaw = doc.resolve(fieldDict.get('TI'));
  const top = typeof tiRaw === 'number' ? tiRaw : 0;
  const sel = selectedIndices(doc, fieldDict, entries, value);
  const [r, gg, b] = da.color;
  let s = '';
  // Highlight rectangles behind the selected rows (painted first).
  labels.forEach((_, i) => {
    if (i < top || !sel.has(i)) return;
    const yTop = g.h - inset - (i - top) * line;
    s += `0.6 0.6 0.6 rg\n${num(inset)} ${num(yTop - line)} ${num(g.w - 2 * inset)} ${num(line)} re f\n`;
  });
  s += `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n${num(line)} TL\n`;
  s += `${num(PAD + inset)} ${num(g.h - inset - size * 0.85)} Td\n`;
  labels.forEach((label, i) => {
    if (i < top) return;
    if (i > top) s += 'T*\n';
    s += `${serializeString(encodeWinAnsi(label))} Tj\n`;
  });
  return s + 'ET';
}

function widgetsOf(doc: Document, fieldDict: PdfDict): PdfDict[] {
  const kids = doc.resolve(fieldDict.get('Kids'));
  if (!isArray(kids)) return [fieldDict];
  const out: PdfDict[] = [];
  for (const k of kids) { const d = doc.resolve(k); if (isDict(d)) out.push(d as PdfDict); }
  return out.length ? out : [fieldDict];
}

/** Generate and install appearance stream(s) for one terminal field across all
 *  its widgets. Best-effort: widgets with no usable geometry are skipped. */
export function generateFieldAppearance(
  doc: Document, acroForm: PdfDict, fieldDict: PdfDict,
  type: FieldType, ff: number, value: PdfObject,
): void {
  const da = resolveDA(doc, fieldDict, acroForm);
  const q = qOf(doc, fieldDict, acroForm);
  const widgets = widgetsOf(doc, fieldDict);
  for (let wi = 0; wi < widgets.length; wi++) {
    const widget = widgets[wi];
    const g = widgetGeom(doc, widget);
    if (!g) continue;
    const mk = mkOps(doc, widget, g);
    let body: string | undefined;
    switch (type) {
      case 'text': {
        const maxLenRaw = doc.resolve(fieldDict.get('MaxLen'));
        const maxLen = typeof maxLenRaw === 'number' ? maxLenRaw : 0;
        const shown = maskIfPassword(textOf(value), ff);
        if ((ff & FF_COMB) && maxLen > 0 && !(ff & FF_MULTILINE))
          body = combText(shown, da, g, maxLen, mk.inset);
        else if (ff & FF_MULTILINE)
          body = multilineText(shown, da, g, mk.inset);
        else
          body = singleLineText(shown, da, g, q, mk.inset);
        break;
      }
      case 'checkbox':
      case 'radio': {
        // Preserve author-supplied appearances; synthesize only when missing.
        if (hasNStates(doc, widget)) { body = undefined; break; }
        buildButtonAP(doc, widget, synthOnState(doc, widget, fieldDict, wi, value), type, da);
        body = undefined; // already installed per state
        break;
      }
      case 'choice': {
        const entries = parseOptions(doc, fieldDict);
        if (ff & FF_COMBO) {
          // Draw the display text for the selected export. A value matching no
          // option is an editable combo's free text and renders as typed.
          const raw = textOf(value);
          const hit = entries.find((e) => e.export === raw);
          body = singleLineText(hit ? displayOf(hit) : raw, da, g, q, mk.inset);
        } else {
          body = listBox(doc, fieldDict, da, g, mk.inset, value, entries);
        }
        break;
      }
      default:
        body = undefined; // pushbutton / signature / unknown — never display a value
    }
    if (body === undefined) continue;
    installAP(doc, widget, buildAppearanceXObject(doc, g, da.std, 'Helv', mk.ops + clipOps(g, mk.inset) + body));
  }
}
