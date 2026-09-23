// A FreeText's rich text (`/RC`, ISO 32000-1 12.7.3.4) as styled paragraphs,
// and those paragraphs laid out and emitted as a content-stream body
// (`v0tz.3`). A pure leaf: no Document, no allocation — the caller decides
// where the fonts it names live.
//
// Parsing is xml.ts's, exactly as richtext.ts parses the same markup for
// search, and the block-boundary rule is richtext.ts's RICH_BLOCK_ELEMENTS, so
// the two cannot disagree about where a paragraph ends. CSS is cssparse.ts's
// grammar and cssvalue.ts's colours: one owner each. Layout is layout.ts's
// layoutRuns — the ONE wrapping engine — with a Standard-14 winAnsiDriver per
// face.
import { parseXml, type XmlNode } from './xml.js';
import { parseDeclarationList, type CssValue } from './cssparse.js';
import { colorOf, trimWs } from './cssvalue.js';
import { layoutRuns, winAnsiDriver, type FontDriver } from './layout.js';
import type { StdFont } from './metrics.js';
import { vmetricsFor } from './textdecor.js';
import { serializeString } from './serialize.js';
import { num } from './pagecontent.js';
import { RICH_BLOCK_ELEMENTS } from './richtext.js';
import { rethrowLimit } from './errors.js';

export type Family = 'Helvetica' | 'Times' | 'Courier';
export type RichAlign = 'left' | 'center' | 'right' | 'justify';

export interface RichStyle {
  family: Family; bold: boolean; italic: boolean; size: number;
  color: [number, number, number]; underline: boolean; strike: boolean; align: RichAlign;
}
export interface RichRun {
  text: string; face: StdFont; size: number;
  color: [number, number, number]; underline: boolean; strike: boolean;
}
export interface RichParagraph { align: RichAlign; runs: RichRun[] }

const FACES: Record<Family, [StdFont, StdFont, StdFont, StdFont]> = {
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** The Standard-14 face for a style: regular, bold, italic, bold-italic. */
export function faceOf(s: RichStyle): StdFont {
  return FACES[s.family][(s.bold ? 1 : 0) + (s.italic ? 2 : 0)];
}

/** A base style from a Standard-14 face — how a FreeText's /DA font seeds the
 *  run model. Symbol and ZapfDingbats are not text faces; they seed Helvetica. */
export function styleFromFace(
  face: StdFont, size: number, color: [number, number, number], align: RichAlign,
): RichStyle {
  const family: Family = face.startsWith('Times') ? 'Times' : face.startsWith('Courier') ? 'Courier' : 'Helvetica';
  const text = family === 'Helvetica' && !face.startsWith('Helvetica') ? 'Helvetica' : face;
  return {
    family, bold: /Bold/.test(text), italic: /Italic|Oblique/.test(text), size,
    color, underline: false, strike: false, align,
  };
}

/** Family names recognised, lower-cased. Probed with hasOwnProperty: a
 *  family name comes from the document, and `in` would find `constructor`. */
const FAMILY_NAMES: Readonly<Record<string, Family>> = {
  helvetica: 'Helvetica', arial: 'Helvetica', 'sans-serif': 'Helvetica',
  times: 'Times', 'times new roman': 'Times', 'times-roman': 'Times', serif: 'Times',
  courier: 'Courier', 'courier new': 'Courier', monospace: 'Courier',
};
const familyNamed = (n: string): Family | undefined =>
  Object.prototype.hasOwnProperty.call(FAMILY_NAMES, n) ? FAMILY_NAMES[n] : undefined;

const positive = (n: number): number | undefined => (Number.isFinite(n) && n > 0 ? n : undefined);

/** A font size from one token: pt, px (x0.75), em (x parent), in, mm, cm,
 *  percent, or a unitless number read as pt — which producers do write. */
function sizeOf(t: CssValue, parent: number): number | undefined {
  if (t.kind === 'dimension') {
    const u = t.unit.toLowerCase();
    const k = u === 'pt' ? 1 : u === 'px' ? 0.75 : u === 'em' ? parent
      : u === 'in' ? 72 : u === 'mm' ? 72 / 25.4 : u === 'cm' ? 72 / 2.54 : undefined;
    return k === undefined ? undefined : positive(t.value * k);
  }
  if (t.kind === 'percentage') return positive((parent * t.value) / 100);
  if (t.kind === 'number') return positive(t.value);
  return undefined;
}

/** The first recognised family among comma-separated parts of `v`. */
function familyOf(v: CssValue[]): Family | undefined {
  const parts: string[][] = [[]];
  for (const t of v) {
    if (t.kind === 'comma') parts.push([]);
    else if (t.kind === 'ident' || t.kind === 'string') parts[parts.length - 1].push(t.value);
  }
  for (const p of parts) {
    const f = familyNamed(p.join(' ').trim().toLowerCase());
    if (f) return f;
  }
  return undefined;
}

/** `font`: style and weight keywords, a size, and a family list, in ANY
 *  order — Acrobat writes `font: Helvetica,sans-serif 12.0pt`, family first,
 *  which a strict CSS reading refuses. A `/line-height` is skipped. Properties
 *  the shorthand does not state are kept rather than reset. */
function applyFont(v: CssValue[], s: RichStyle): void {
  const familyTokens: CssValue[] = [];
  for (let i = 0; i < v.length; i++) {
    const t = v[i];
    if (t.kind === 'whitespace') { familyTokens.push(t); continue; }
    if (t.kind === 'delim' && t.value === '/') {
      while (i + 1 < v.length && v[i + 1].kind === 'whitespace') i++;
      i++;
      continue;
    }
    if (t.kind === 'ident') {
      const k = t.value.toLowerCase();
      if (k === 'italic' || k === 'oblique') { s.italic = true; continue; }
      if (k === 'bold' || k === 'bolder') { s.bold = true; continue; }
      if (k === 'lighter') { s.bold = false; continue; }
      if (k === 'normal') continue;
    }
    if (t.kind === 'number' && t.int && t.value >= 100 && t.value <= 900 && t.value % 100 === 0) {
      s.bold = t.value >= 600;
      continue;
    }
    const size = sizeOf(t, s.size);
    if (size !== undefined && t.kind !== 'number') { s.size = size; continue; }
    familyTokens.push(t);
  }
  const f = familyOf(familyTokens);
  if (f) s.family = f;
}

/** `style` declarations over `s`. A declaration that does not parse, or names
 *  a value this does not read, is skipped: the run keeps what it inherited. */
export function applyStyle(css: string, s: RichStyle): RichStyle {
  const out: RichStyle = { ...s };
  for (const d of parseDeclarationList(css)) {
    if (d.kind !== 'declaration') continue;
    const v = trimWs(d.value);
    if (v.length === 0) continue;
    const kw = v.length === 1 && v[0].kind === 'ident' ? v[0].value.toLowerCase() : undefined;
    switch (d.name.toLowerCase()) {
      case 'font-size': {
        const size = v.length === 1 ? sizeOf(v[0], s.size) : undefined;
        if (size !== undefined) out.size = size;
        break;
      }
      case 'font-weight':
        if (kw === 'bold' || kw === 'bolder') out.bold = true;
        else if (kw === 'normal' || kw === 'lighter') out.bold = false;
        else if (v.length === 1 && v[0].kind === 'number') out.bold = v[0].value >= 600;
        break;
      case 'font-style':
        if (kw === 'italic' || kw === 'oblique') out.italic = true;
        else if (kw === 'normal') out.italic = false;
        break;
      case 'font-family': {
        const f = familyOf(v);
        if (f) out.family = f;
        break;
      }
      case 'font':
        applyFont(v, out);
        break;
      case 'color': {
        const c = colorOf(v);
        if (c && c !== 'currentcolor' && c.a > 0) out.color = [c.rgb[0], c.rgb[1], c.rgb[2]];
        break;
      }
      case 'text-align':
        if (kw === 'left' || kw === 'start') out.align = 'left';
        else if (kw === 'right' || kw === 'end') out.align = 'right';
        else if (kw === 'center' || kw === 'justify') out.align = kw;
        break;
      case 'text-decoration': {
        const words = v.filter((t) => t.kind === 'ident').map((t) => (t as { value: string }).value.toLowerCase());
        if (words.length === 0) break;
        out.underline = words.includes('underline');
        out.strike = words.includes('line-through');
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const sameStyle = (a: RichRun, b: RichRun): boolean =>
  a.face === b.face && a.size === b.size && a.underline === b.underline && a.strike === b.strike
  && a.color[0] === b.color[0] && a.color[1] === b.color[1] && a.color[2] === b.color[2];

/** Accumulates paragraphs while walking. */
class Builder {
  readonly paras: RichParagraph[] = [];
  private cur: RichParagraph | undefined;

  open(align: RichAlign): void { this.close(); this.cur = { align, runs: [] }; }

  close(): void {
    const p = this.cur;
    this.cur = undefined;
    if (!p) return;
    // Trailing whitespace and line breaks are layout, not content.
    while (p.runs.length > 0) {
      const last = p.runs[p.runs.length - 1];
      last.text = last.text.replace(/[ \n]+$/, '');
      if (last.text !== '') break;
      p.runs.pop();
    }
    if (p.runs.length > 0) this.paras.push(p);
  }

  private append(text: string, s: RichStyle): void {
    if (!this.cur) this.cur = { align: s.align, runs: [] };
    const runs = this.cur.runs;
    const last = runs[runs.length - 1];
    const run: RichRun = {
      text, face: faceOf(s), size: s.size, color: s.color, underline: s.underline, strike: s.strike,
    };
    if (last && sameStyle(last, run)) last.text += text;
    else runs.push(run);
  }

  /** XHTML whitespace: every run of whitespace is one space, and a space at the
   *  start of a line — or after one already emitted — is dropped, so a space
   *  never doubles across a run boundary. */
  text(raw: string, s: RichStyle): void {
    let t = raw.replace(/[ \t\r\n\f\v]+/g, ' ');
    const runs = this.cur?.runs ?? [];
    const last = runs[runs.length - 1];
    if (!last || /[ \n]$/.test(last.text)) t = t.replace(/^ /, '');
    if (t !== '') this.append(t, s);
  }

  br(s: RichStyle): void {
    const runs = this.cur?.runs ?? [];
    const last = runs[runs.length - 1];
    if (last) last.text = last.text.replace(/ +$/, '');
    this.append('\n', s);
  }

  visit(node: XmlNode, s: RichStyle): void {
    for (const n of node.nodes) {
      if (typeof n === 'string') { this.text(n, s); continue; }
      const tag = n.name.toLowerCase();
      if (tag === 'br') { this.br(s); continue; }
      let cs = s;
      if (tag === 'b' || tag === 'strong') cs = { ...cs, bold: true };
      if (tag === 'i' || tag === 'em') cs = { ...cs, italic: true };
      const style = n.attrs.get('style');
      if (style !== undefined) cs = applyStyle(style, cs);
      if (RICH_BLOCK_ELEMENTS.has(tag)) {
        this.open(cs.align);
        this.visit(n, cs);
        this.close();
      } else {
        this.visit(n, cs);
      }
    }
  }
}

/** `/RC` markup as paragraphs of styled runs, `/DS` applied beneath
 *  everything, or `undefined` when the markup will not parse — the caller then
 *  draws plain /Contents, and never a regex strip of the markup.
 *
 *  The fragment is wrapped in a synthetic root, as richtext.ts wraps it: a
 *  fragment legitimately has several top-level elements and parseXml returns
 *  one. An element outside the vocabulary is TRANSPARENT — its text kept, its
 *  tag ignored — so unknown markup never loses words. */
export function parseRichText(
  markup: string, ds: string | undefined, base: RichStyle,
): RichParagraph[] | undefined {
  let root: XmlNode;
  try {
    root = parseXml(new TextEncoder().encode(`<pdf4ts-rich>${markup}</pdf4ts-rich>`));
  } catch (caught) {
    rethrowLimit(caught);
    return undefined;
  }
  const b = new Builder();
  b.visit(root, ds === undefined ? base : applyStyle(ds, base));
  b.close();
  return b.paras;
}

/** A laid-out rich-text body and the faces its `Tf` operators name. */
export interface RichBody { body: string; faces: Map<string, StdFont> }

/** Space the line's words so it fills `avail`: `Tw` applies to byte 32 of a
 *  single-byte font, which WinAnsi is. Never the last line of a paragraph —
 *  the rule `stamp.ts`'s own justify follows. */
function justifyTw(align: RichAlign, avail: number, line: { text: string; width: number; hardBreak: boolean }): number {
  if (align !== 'justify' || line.hardBreak) return 0;
  let gaps = 0;
  for (const ch of line.text) if (ch === ' ') gaps++;
  const slack = avail - line.width;
  return gaps > 0 && slack > 0 ? slack / gaps : 0;
}

/** Paragraphs laid out by layoutRuns, top-anchored in a `boxW` x `boxH` box
 *  inset by `inset`, and emitted as one BT…ET with each line placed by `Tm`,
 *  followed by filled rects for underline and line-through (geometry from
 *  textdecor.ts's vmetricsFor, so they sit where the rest of the library puts
 *  them).
 *
 *  `inset` is the WHOLE inset, the appearance text PAD included — the caller
 *  adds it. That is what keeps this module a leaf: reading `PAD` from
 *  appearance.ts was its one non-leaf import, and `v0tz.5` needs
 *  appearance.ts to import THIS module, which would have closed a 2-cycle
 *  (`test/import-cycles.test.ts` fences those as a red build). It was only
 *  ever used as `inset + PAD`, so folding it into the parameter moves no
 *  bytes — `test/freetext-rich.test.ts`'s hash is the fence.
 *
 *  A line's baseline sits its `maxFontSize` below the band top and the band is
 *  `height` tall — layoutRuns' per-line rule, so a larger run makes its own
 *  line taller. Text past the box bottom is still emitted: the form's /BBox
 *  clips it, as it clips the plain path, and a viewer does not shrink FreeText
 *  to fit. */
export function richTextBody(
  paras: readonly RichParagraph[], boxW: number, boxH: number, inset: number,
): RichBody {
  const x0 = inset;
  const avail = Math.max(1, boxW - 2 * inset);
  const faces = new Map<string, StdFont>();
  const keys = new Map<StdFont, string>();
  const drivers = new Map<StdFont, FontDriver>();
  const keyOf = (f: StdFont): string => {
    let k = keys.get(f);
    if (k === undefined) { k = `F${keys.size}`; keys.set(f, k); faces.set(k, f); }
    return k;
  };
  const driverOf = (f: StdFont): FontDriver => {
    let d = drivers.get(f);
    if (d === undefined) { d = winAnsiDriver(f); drivers.set(f, d); }
    return d;
  };

  const text: string[] = ['BT'];
  const rules: string[] = [];
  let top = boxH - inset;
  let curFont = '', curColor = '', curTw = 0;

  for (const p of paras) {
    if (p.runs.length === 0) continue;
    const base = p.runs[0].size;
    const laid = layoutRuns(
      p.runs.map((r) => ({ text: r.text, driver: driverOf(r.face), fontSize: r.size })),
      avail, 1e9, base * 1.15, base,
    );
    for (const line of laid.lines) {
      const baseline = top - line.maxFontSize;
      const tw = justifyTw(p.align, avail, line);
      let x = x0;
      if (p.align === 'center') x = x0 + (avail - line.width) / 2;
      else if (p.align === 'right') x = x0 + avail - line.width;
      if (x < x0) x = x0;
      text.push(`1 0 0 1 ${num(x)} ${num(baseline)} Tm`);
      if (tw !== curTw) { text.push(`${num(tw)} Tw`); curTw = tw; }
      for (const seg of line.segments) {
        const r = p.runs[seg.run];
        let spaces = 0;
        for (const ch of seg.text) if (ch === ' ') spaces++;
        const w = seg.width + tw * spaces;
        if (seg.bytes.length > 0) {
          const font = `/${keyOf(r.face)} ${num(r.size)} Tf`;
          if (font !== curFont) { text.push(font); curFont = font; }
          const color = `${num(r.color[0])} ${num(r.color[1])} ${num(r.color[2])} rg`;
          if (color !== curColor) { text.push(color); curColor = color; }
          text.push(`${serializeString(seg.bytes)} Tj`);
          if (r.underline || r.strike) {
            const vm = vmetricsFor(r.face);
            if (r.underline) {
              const t = vm.underlineThickness * r.size;
              rules.push(`${color} ${num(x)} ${num(baseline + vm.underlineOffset * r.size - t / 2)} ${num(w)} ${num(t)} re f`);
            }
            if (r.strike) {
              const t = vm.strikeThickness * r.size;
              rules.push(`${color} ${num(x)} ${num(baseline + vm.strikeOffset * r.size - t / 2)} ${num(w)} ${num(t)} re f`);
            }
          }
        }
        x += w;
      }
      top -= line.height;
    }
  }
  if (curTw !== 0) text.push('0 Tw');
  text.push('ET');
  return { body: text.join('\n') + (rules.length ? `\n${rules.join('\n')}` : ''), faces };
}
