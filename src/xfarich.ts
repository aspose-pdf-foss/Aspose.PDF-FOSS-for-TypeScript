// src/xfarich.ts
/**
 * What an XFA leaf (`<field>` or `<draw>`) asks to be measured with (`164g.7`):
 * its value as paragraphs of styled runs, its insets and its caption.
 *
 * **Invariant: a pure leaf over `xml.js`, `xfageom.js` and the CSS parser.** No
 * `Document`, no font, no PDF object, and it never throws -- what cannot be
 * modelled is `refusal`, which the converter turns into a reason.
 *
 * Every rule is XFA 3.3's: font defaults from the Template Reference `font`
 * element (p. 743: size 10pt, typeface Courier, weight and posture normal --
 * the p. 58 prose says the default weight is bold, and the normative syntax
 * wins); rich text from ch. 27 (p. 1187-1221), where an UNRECOGNISED element is
 * ignored with its content, unlike `richtext.ts`'s transparent rule for /RC.
 */
import type { XmlNode } from './xml.js';
import { measureToPt } from './xfageom.js';
import { parseDeclarationList, type CssValue } from './cssparse.js';
import { trimWs } from './cssvalue.js';

export interface RunStyle { family: string[]; size: number; bold: boolean; italic: boolean }
export interface RunSpec extends RunStyle { text: string }
export interface ParaSpec {
  runs: RunSpec[];
  /** The style an empty paragraph (or an empty line) measures in. */
  base: RunStyle;
  marginLeft: number; marginRight: number; textIndent: number;
  lineHeight: number; spaceAbove: number; spaceBelow: number;
}
export type CaptionSide = 'left' | 'right' | 'top' | 'bottom';
export interface LeafText {
  /** `geometry`: a rectangle, line or arc draw, sized by `min*` alone (p. 276). */
  kind: 'text' | 'geometry';
  paras: ParaSpec[];
  insets: { l: number; r: number; t: number; b: number };
  caption?: { placement: CaptionSide; reserve?: number };
  password: boolean;
  /** The field states a display `<format><picture>`, which is not formatted. */
  picture: boolean;
  refusal?: string;
}

type ParaBox = Omit<ParaSpec, 'runs' | 'base'>;
const ZERO_PARA: ParaBox = { marginLeft: 0, marginRight: 0, textIndent: 0, lineHeight: 0, spaceAbove: 0, spaceBelow: 0 };
const DEFAULT_STYLE: RunStyle = { family: ['Courier'], size: 10, bold: false, italic: false };
const TEXT_UI = new Set(['textEdit', 'numericEdit', 'dateTimeEdit', 'passwordEdit']);
const GEOMETRY = new Set(['rectangle', 'line', 'arc']);

const child = (n: XmlNode, name: string): XmlNode | undefined => n.children.find((c) => c.name === name);

/** A measurement in points, or a refusal naming the attribute. */
function pt(v: string | undefined, what: string, fallback: number): number | { refusal: string } {
  if (v === undefined || v === '') return fallback;
  const p = measureToPt(v);
  return p === undefined ? { refusal: `${what}="${v}" could not be read as a measurement` } : p;
}

/** The leaf's own <font>, or why it cannot be measured with. */
function fontOf(el: XmlNode): RunStyle | { refusal: string } {
  const f = child(el, 'font');
  if (!f) return { ...DEFAULT_STYLE };
  const size = pt(f.attrs.get('size'), 'font size', 10);
  if (typeof size === 'object') return size;
  const bs = f.attrs.get('baselineShift');
  if (bs !== undefined && bs !== '' && measureToPt(bs) !== 0)
    return { refusal: `font baselineShift="${bs}" is not measured` };
  for (const k of ['fontHorizontalScale', 'fontVerticalScale'] as const) {
    const v = f.attrs.get(k);
    if (v !== undefined && v !== '' && v.trim() !== '100%') return { refusal: `font ${k}="${v}" is not measured` };
  }
  const ls = f.attrs.get('letterSpacing');
  if (ls !== undefined && ls !== '' && measureToPt(ls) !== 0) return { refusal: `font letterSpacing="${ls}" is not measured` };
  if (f.attrs.get('kerningMode') === 'pair') return { refusal: 'font kerningMode="pair" is not measured' };
  const face = f.attrs.get('typeface');
  return {
    family: [face !== undefined && face !== '' ? face : 'Courier'],
    size,
    bold: f.attrs.get('weight') === 'bold',
    italic: f.attrs.get('posture') === 'italic',
  };
}

function paraOf(el: XmlNode): ParaBox | { refusal: string } {
  const p = child(el, 'para');
  if (!p) return { ...ZERO_PARA };
  if (p.attrs.get('hAlign') === 'radix') return { refusal: 'para hAlign="radix" is not measured' };
  const hy = child(p, 'hyphenation');
  if (hy && hy.attrs.get('hyphenate') === '1') return { refusal: 'para hyphenation is not measured' };
  const out = { ...ZERO_PARA };
  for (const k of Object.keys(ZERO_PARA) as (keyof ParaBox)[]) {
    const v = pt(p.attrs.get(k), `para ${k}`, 0);
    if (typeof v === 'object') return v;
    out[k] = v;
  }
  return out;
}

function insetsOf(el: XmlNode): LeafText['insets'] | { refusal: string } {
  const m = child(el, 'margin');
  const out = { l: 0, r: 0, t: 0, b: 0 };
  if (!m) return out;
  const keys = { l: 'leftInset', r: 'rightInset', t: 'topInset', b: 'bottomInset' } as const;
  for (const [k, a] of Object.entries(keys) as [keyof typeof keys, string][]) {
    const v = pt(m.attrs.get(a), `margin ${a}`, 0);
    if (typeof v === 'object') return v;
    out[k] = v;
  }
  return out;
}

function captionOf(el: XmlNode): LeafText['caption'] | { refusal: string } | undefined {
  const c = child(el, 'caption');
  if (!c) return undefined;
  const presence = c.attrs.get('presence');
  if (presence === 'hidden' || presence === 'inactive') return undefined;
  const pl = c.attrs.get('placement') ?? 'left';
  if (pl !== 'left' && pl !== 'right' && pl !== 'top' && pl !== 'bottom')
    return { refusal: `caption placement="${pl}" is not one of the four` };
  const r = c.attrs.get('reserve');
  if (r === undefined || r === '') return { placement: pl };
  const v = measureToPt(r);
  return v === undefined ? { refusal: `caption reserve="${r}" could not be read as a measurement` } : { placement: pl, reserve: v };
}

/** Plain text: one paragraph per record (p. 56: a newline or U+2029 delimits a
 *  record). An empty string is ONE empty paragraph, which measures one line. */
export function plainParas(text: string, base: RunStyle, para: ParaBox): ParaSpec[] {
  return text.split(/\r\n|\r|\n|\u2029/).map((rec) => ({
    ...para, base, runs: rec === '' ? [] : [{ ...base, text: rec }],
  }));
}

// ---- rich text ------------------------------------------------------------------

/** p. 1187-1188: the elements, and the CSS properties that change no size. */
const INLINE = new Set(['span', 'b', 'i', 'a']);
const CONTAINER = new Set(['html', 'body']);
const NO_SIZE = new Set(['color', 'text-decoration', 'orphans', 'widows', 'page-break-after',
  'page-break-before', 'page-break-inside', 'text-align']);

interface Ctx { style: RunStyle; spacerun: boolean }

function familyList(v: CssValue[]): string[] | undefined {
  const out: string[] = [];
  let cur: string[] = [];
  for (const t of v) {
    if (t.kind === 'comma') { if (cur.length) out.push(cur.join(' ')); cur = []; continue; }
    if (t.kind === 'ident' || t.kind === 'string') cur.push(t.value);
  }
  if (cur.length) out.push(cur.join(' '));
  return out.length ? out : undefined;
}

function cssPt(t: CssValue): number | undefined {
  if (t.kind === 'number') return t.value === 0 ? 0 : undefined;
  if (t.kind !== 'dimension') return undefined;
  return measureToPt(`${t.repr}${t.unit}`);
}

/** Apply one element's `style`; a refusal names the property. */
function applyCss(css: string, ctx: Ctx, para: ParaBox | undefined): Ctx | { refusal: string } {
  const style = { ...ctx.style };
  let spacerun = ctx.spacerun;
  for (const d of parseDeclarationList(css)) {
    if (d.kind !== 'declaration') continue;
    const name = d.name.toLowerCase();
    const v = trimWs(d.value);
    if (v.length === 0 || NO_SIZE.has(name)) continue;
    const kw = v.length === 1 && v[0].kind === 'ident' ? v[0].value.toLowerCase() : undefined;
    switch (name) {
      case 'font-size': {
        const p = v.length === 1 ? cssPt(v[0]) : undefined;
        if (p === undefined || p <= 0) return { refusal: `font-size in rich text could not be read in points` };
        style.size = p; break;
      }
      case 'font-weight':
        if (kw === 'bold') style.bold = true;
        else if (kw === 'normal') style.bold = false;
        else if (v.length === 1 && v[0].kind === 'number') style.bold = v[0].value >= 600;
        else return { refusal: 'font-weight in rich text could not be read' };
        break;
      case 'font-style':
        if (kw === 'italic' || kw === 'oblique') style.italic = true;
        else if (kw === 'normal') style.italic = false;
        else return { refusal: 'font-style in rich text could not be read' };
        break;
      case 'font-family': {
        const f = familyList(v);
        if (!f) return { refusal: 'font-family in rich text could not be read' };
        style.family = f; break;
      }
      case 'font-stretch':
        if (kw !== 'normal') return { refusal: 'font-stretch in rich text is not measured' };
        break;
      case 'xfa-spacerun':
        spacerun = kw === 'yes'; break;
      case 'margin-top': case 'margin-bottom': case 'margin-left': case 'margin-right':
      case 'text-indent': case 'line-height': {
        const p = v.length === 1 ? cssPt(v[0]) : undefined;
        if (p === undefined) return { refusal: `${name} in rich text could not be read in points` };
        if (!para) return { refusal: `${name} on an inline element is not measured` };
        const key = ({ 'margin-top': 'spaceAbove', 'margin-bottom': 'spaceBelow', 'margin-left': 'marginLeft',
          'margin-right': 'marginRight', 'text-indent': 'textIndent', 'line-height': 'lineHeight' } as const)[name];
        para[key] = p; break;
      }
      case 'letter-spacing':
        if (!(v.length === 1 && cssPt(v[0]) === 0) && kw !== 'normal') return { refusal: 'letter-spacing in rich text is not measured' };
        break;
      case 'kerning-mode':
        if (kw !== 'none') return { refusal: 'kerning-mode in rich text is not measured' };
        break;
      case 'vertical-align':
        if (kw !== 'baseline') return { refusal: 'vertical-align in rich text is not measured' };
        break;
      default:
        // margin shorthand, tab stops, font shorthand, font scale: not modelled.
        return { refusal: `${name} in rich text is not measured` };
    }
  }
  return { style, spacerun };
}

class RichBuilder {
  readonly paras: ParaSpec[] = [];
  private cur: ParaSpec | undefined;
  refusal: string | undefined;
  constructor(private readonly base: RunStyle, private readonly para: ParaBox) {}

  open(p: ParaBox, s: RunStyle): void { this.close(); this.cur = { ...p, base: s, runs: [] }; }
  close(): void {
    const p = this.cur;
    this.cur = undefined;
    if (!p) return;
    // A trailing space is KEPT: p. 58 keeps trailing white space in the layout
    // and p. 1220 keeps a spacerun's. At a fixed width it moves nothing; on a
    // width-growable leaf xfatext.ts refuses it rather than measure it.
    this.paras.push(p);
  }
  private para0(s: RunStyle): ParaSpec {
    if (!this.cur) this.cur = { ...this.para, base: s, runs: [] };
    return this.cur;
  }
  text(raw: string, ctx: Ctx): void {
    const p = this.para0(ctx.style);
    let t: string;
    if (ctx.spacerun) {
      // p. 1220: each U+00A0 or space in a spacerun is one space. Two or more
      // would be collapsed by layoutRuns, changing the wrap: refuse.
      t = raw.replace(/\u00A0/g, ' ').replace(/[\t\r\n]/g, '');
      if (/ {2,}/.test(t)) { this.refusal ??= 'two or more spaces in an xfa-spacerun span are not measured'; return; }
    } else {
      t = raw.replace(/[ \t\r\n\f]+/g, ' ');
      const prev = p.runs[p.runs.length - 1];
      if (!prev || /[ \n]$/.test(prev.text)) t = t.replace(/^ /, '');
    }
    if (t === '') return;
    const prev = p.runs[p.runs.length - 1];
    const s = ctx.style;
    if (prev && prev.size === s.size && prev.bold === s.bold && prev.italic === s.italic
      && prev.family.join('\0') === s.family.join('\0')) prev.text += t;
    else p.runs.push({ ...s, text: t });
  }
  br(ctx: Ctx): void {
    const p = this.para0(ctx.style);
    const prev = p.runs[p.runs.length - 1];
    if (prev) prev.text = prev.text.replace(/ +$/, '');
    p.runs.push({ ...ctx.style, text: '\n' });
  }
}

function walkRich(n: XmlNode, ctx: Ctx, b: RichBuilder): void {
  for (const c of n.nodes) {
    if (b.refusal) return;
    if (typeof c === 'string') { b.text(c, ctx); continue; }
    const name = c.name.toLowerCase();
    if (name === 'br') { b.br(ctx); continue; }
    if (name === 'sub' || name === 'sup') { b.refusal = `<${name}> in rich text is not measured`; return; }
    if (name === 'ol' || name === 'ul' || name === 'li') { b.refusal = 'a list in rich text is not measured'; return; }
    if (name === 'span' && c.attrs.has('embed')) { b.refusal = 'an embedded-object span is not measured'; return; }
    const isP = name === 'p';
    if (!isP && !INLINE.has(name) && !CONTAINER.has(name)) continue; // p. 1187: dropped with content
    const para: ParaBox | undefined = isP ? { ...ZERO_PARA } : undefined;
    let next: Ctx = { ...ctx, style: { ...ctx.style } };
    if (name === 'b') next.style.bold = true;
    if (name === 'i') next.style.italic = true;
    const css = c.attrs.get('style');
    if (css !== undefined) {
      const r = applyCss(css, next, para);
      if ('refusal' in r) { b.refusal = r.refusal; return; }
      next = r;
    }
    if (isP) b.open(para!, next.style);
    walkRich(c, next, b);
    if (isP) b.close();
  }
}

/** The leaf's whole measurable description. Never throws. */
export function leafText(el: XmlNode): LeafText {
  const insets = insetsOf(el);
  const font = fontOf(el);
  const para = paraOf(el);
  const caption = el.name === 'field' ? captionOf(el) : undefined;
  const uiEl = child(el, 'ui')?.children[0];
  const fmt = child(el, 'format');
  const out: LeafText = {
    kind: 'text', paras: [],
    insets: 'refusal' in insets ? { l: 0, r: 0, t: 0, b: 0 } : insets,
    ...(caption && !('refusal' in caption) ? { caption } : {}),
    password: uiEl?.name === 'passwordEdit',
    picture: fmt !== undefined && child(fmt, 'picture') !== undefined,
  };
  const fail = [insets, font, para, caption].find((x) => x !== undefined && 'refusal' in x) as { refusal: string } | undefined;
  if (fail) return { ...out, refusal: fail.refusal };
  const base = font as RunStyle;
  const pb = para as ParaBox;
  if (el.name === 'field' && uiEl && !TEXT_UI.has(uiEl.name))
    return { ...out, refusal: `a growable <${uiEl.name}> field is not measured` };
  const value = child(el, 'value');
  const v = value?.children[0];
  if (v && GEOMETRY.has(v.name)) return { ...out, kind: 'geometry' };
  if (v && v.name === 'image') return { ...out, refusal: 'a growable image draw is not measured' };
  if (v && v.name === 'exData') {
    const ct = v.attrs.get('contentType');
    if (ct !== 'text/html') return { ...out, refusal: `exData contentType="${ct ?? ''}" is not measured` };
    const b = new RichBuilder(base, pb);
    walkRich(v, { style: base, spacerun: false }, b);
    b.close();
    // A refusal about the VALUE keeps the base paragraph, so a bound datasets
    // value can still replace it (withValue); every other refusal has none.
    if (b.refusal) return { ...out, paras: plainParas('', base, pb), refusal: b.refusal };
    const paras = b.paras.length ? b.paras : plainParas('', base, pb);
    return { ...out, paras };
  }
  const text = v ? v.text : '';
  const keep = plainParas('', base, pb);
  if (text.includes('\t')) return { ...out, paras: keep, refusal: 'a tab character is not measured' };
  if (out.picture && text !== '') return { ...out, paras: keep, refusal: 'a value under a display picture is not formatted' };
  return { ...out, paras: plainParas(text, base, pb) };
}

/** A field's description with its bound datasets value as plain text. */
export function withValue(t: LeafText, value: string): LeafText {
  if (t.kind !== 'text') return t;
  // A refusal with no paragraph is about the font, para, insets or ui, which
  // the value does not change.
  if (t.refusal !== undefined && t.paras.length === 0) return t;
  const { refusal: _ignored, ...rest } = t;
  if (value.includes('\t')) return { ...rest, refusal: 'a tab character is not measured' };
  if (t.picture && value !== '') return { ...rest, refusal: 'a value under a display picture is not formatted' };
  const p = t.paras[0];
  const base = p ? p.base : DEFAULT_STYLE;
  const box: ParaBox = p ? { marginLeft: p.marginLeft, marginRight: p.marginRight, textIndent: p.textIndent,
    lineHeight: p.lineHeight, spaceAbove: p.spaceAbove, spaceBelow: p.spaceBelow } : { ...ZERO_PARA };
  return { ...rest, paras: plainParas(value, base, box) };
}
