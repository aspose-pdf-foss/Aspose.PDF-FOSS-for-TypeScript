/** WordprocessingML styles, theme fonts, and property resolution (`m2fp.3`).
 *
 *  **Invariant:** the resolution order is ECMA-376 Part 1 17.7.2 —
 *  `docDefaults`, the paragraph style's `basedOn` chain, the numbering level's
 *  `pPr`, the character style's chain, direct formatting — and within one chain
 *  the NEARER style wins. A property is resolved PER FIELD, so a base style's
 *  left indent survives a derived style's right indent.
 *
 *  **Invariant:** toggle properties (b, i, strike) combine across the
 *  paragraph-style and character-style LAYERS by XOR (17.7.3), each layer's
 *  value being its chain-resolved boolean; `docDefaults` answers only when
 *  neither style layer states it; direct formatting sets it ABSOLUTELY. A bold
 *  paragraph style under a bold character style is NOT bold.
 *
 *  **Invariant:** a heading comes from the resolved `w:outlineLvl`, never a
 *  style id — ids are localized (`1` is Heading 1 in Russian Word).
 *
 *  **Invariant:** a `pStyle` that is absent, unknown, or names a style that is
 *  not a paragraph style resolves to the DEFAULT paragraph style; likewise for
 *  `rStyle` and the default character style.
 *
 *  **Invariant:** a `basedOn` walk stops at an unknown id, a style of another
 *  type, a style already visited, or `maxNestingDepth` steps. A cycle is
 *  damage we survive, never a hang.
 *
 *  **Note, measured, a REDUNDANT PAIR under bounded limits:** at the default
 *  `maxNestingDepth` the depth bound ALSO ends a cycle — the walk repeats
 *  A, B, A, B … and `nearest` gives the same answer — so dropping the `seen`
 *  test reddens nothing there. It is load-bearing only when the bound is
 *  `null` (`LoadLimits.unlimited()`), where the walk would never end; one case
 *  in `test/wmlstyles.test.ts` holds it for that reason.
 *
 *  **Word confirmed** (`test/fixtures/docx/wml-oracle.json`): XOR applies
 *  ACROSS the paragraph and character layers only; a toggle restated down one
 *  `basedOn` chain stays set (nearer wins); a theme font outranks the literal
 *  beside it; the size with nothing stated is 10pt.
 *
 *  A property Word states that we do not model is recorded by qualified name
 *  (`unmodelled`), except those in the QUIET sets, which carry no rendering. */
import type { NsElement } from './xmlns.js';
import { nsAttr, nsChild, parseNsXml } from './xmlns.js';
import {
  parseWml, canonNs, W, A, wAttr, wChild, wChildren, onOff, wNum, hexColor, displayName, type Rgb,
} from './wmlns.js';
import { LoadLimits } from './loadlimits.js';
import { PdfParseError } from './errors.js';
import type { TabAlign, TabLeader } from './tabstops.js';

export type Align = 'left' | 'center' | 'right' | 'justify';
export type LineRule = { auto: number } | { exactPt: number } | { atLeastPt: number };
export interface Indent { leftPt?: number; rightPt?: number; firstLinePt?: number; hangingPt?: number }
/** One `w:tab` as stated (v9j3.1); `start`/`end` are read as left/right. */
export interface WmlTabStop { posPt: number; val: 'left' | 'right' | 'center' | 'decimal' | 'bar' | 'num' | 'clear'; leader?: string }
/** A resolved tab stop, in points from the paragraph's margin. */
export interface ParaTab { posPt: number; align: TabAlign; leader: TabLeader }
export interface ParaProps {
  align?: Align; spaceBeforePt?: number; spaceAfterPt?: number; line?: LineRule; indent?: Indent;
  /** (v9j3.1) The stops in force, sorted; absent when none is. */
  tabs?: ParaTab[];
}
export interface RunProps {
  bold: boolean; italic: boolean; underline: boolean; strike: boolean;
  sizePt: number;
  color?: Rgb;
  font?: string;
  eastAsiaFont?: string;
  highlight?: Rgb;
}

export interface FontRef { name?: string; theme?: string }
/** One layer's stated run properties; undefined = not stated, null = stated as auto/none. */
export interface RunLayer {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean;
  sizePt?: number;
  color?: Rgb | null;
  font?: FontRef; eastAsiaFont?: FontRef;
  highlight?: Rgb | null;
  shading?: Rgb | null;
  unmodelled: string[];
}
export interface ParaLayer {
  align?: Align; spaceBeforePt?: number; spaceAfterPt?: number; line?: LineRule; indent?: Indent;
  outlineLvl?: number; numId?: number; ilvl?: number;
  tabs?: WmlTabStop[];
  unmodelled: string[];
}

export interface ThemeFonts { major: { latin?: string; ea?: string }; minor: { latin?: string; ea?: string } }
export interface WmlStyle {
  id: string; type: string; name?: string; basedOn?: string; isDefault: boolean;
  ppr: ParaLayer; rpr: RunLayer;
}
export interface WmlStyles {
  byId: ReadonlyMap<string, WmlStyle>;
  defaultParagraph?: string;
  defaultCharacter?: string;
  defaults: { ppr: ParaLayer; rpr: RunLayer };
  theme: ThemeFonts;
  maxDepth: number;
}
export interface ResolvedParagraph {
  styleId?: string; styleName?: string; heading?: number;
  props: ParaProps; numId?: number; ilvl: number; unmodelled: string[];
}
export interface ResolvedRun { props: RunProps; unmodelled: string[] }

export const EMPTY_THEME: ThemeFonts = { major: {}, minor: {} };
const TWIP = 20;
const DEFAULT_SIZE_PT = 10;

/** ECMA-376 17.18.40 ST_HighlightColor. */
const HIGHLIGHT: ReadonlyMap<string, Rgb> = new Map(Object.entries({
  black: '000000', blue: '0000FF', cyan: '00FFFF', green: '00FF00', magenta: 'FF00FF', red: 'FF0000',
  yellow: 'FFFF00', white: 'FFFFFF', darkBlue: '000080', darkCyan: '008080', darkGreen: '008000',
  darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0',
}).map(([k, v]) => [k, hexColor(v) as Rgb]));

const QUIET_RPR = new Set(['rStyle', 'lang', 'noProof', 'szCs', 'bCs', 'iCs', 'kern', 'snapToGrid', 'webHidden']);
const QUIET_PPR = new Set(['pStyle', 'keepNext', 'keepLines', 'widowControl', 'snapToGrid',
  'autoSpaceDE', 'autoSpaceDN', 'adjustRightInd', 'suppressAutoHyphens', 'rPr', 'sectPr']);

const TAB_VALS = new Set(['left', 'right', 'center', 'decimal', 'bar', 'num', 'clear']);
/** ST_TabTlc to the authoring vocabulary; `heavy` is a solid rule. */
const TAB_LEADER: ReadonlyMap<string, TabLeader> = new Map([
  ['dot', 'dot'], ['hyphen', 'hyphen'], ['underscore', 'underscore'], ['middleDot', 'middleDot'], ['heavy', 'line'],
]);

/** An ST_OnOff ATTRIBUTE stated true; absent or any false spelling is not. */
const onOffAttr = (el: NsElement, local: string): boolean => {
  const v = wAttr(el, local);
  return v === '1' || v === 'true' || v === 'on';
};

const pt = (twips: number | undefined): number | undefined => (twips === undefined ? undefined : twips / TWIP);

function fontRef(el: NsElement, literal: string, theme: string): FontRef | undefined {
  const t = wAttr(el, theme);
  const n = wAttr(el, literal);
  return t === undefined && n === undefined ? undefined : { name: n, theme: t };
}

export function readRunLayer(rPr: NsElement | undefined): RunLayer {
  const out: RunLayer = { unmodelled: [] };
  if (!rPr) return out;
  for (const c of rPr.children) {
    if (c.ns !== W) { out.unmodelled.push(displayName(c)); continue; }
    switch (c.local) {
      case 'b': out.bold = onOff(c); break;
      case 'i': out.italic = onOff(c); break;
      case 'strike': out.strike = onOff(c); break;
      case 'u': out.underline = wAttr(c, 'val') !== 'none'; break;
      case 'sz': { const n = wNum(c); if (n !== undefined && n > 0) out.sizePt = n / 2; break; }
      case 'color': { const v = hexColor(wAttr(c, 'val')); if (v !== undefined) out.color = v; break; }
      case 'rFonts': {
        const f = fontRef(c, 'ascii', 'asciiTheme') ?? fontRef(c, 'hAnsi', 'hAnsiTheme');
        if (f) out.font = f;
        const e = fontRef(c, 'eastAsia', 'eastAsiaTheme');
        if (e) out.eastAsiaFont = e;
        break;
      }
      case 'highlight': {
        const v = wAttr(c, 'val');
        if (v === 'none') out.highlight = null;
        else if (v !== undefined && HIGHLIGHT.has(v)) out.highlight = HIGHLIGHT.get(v)!;
        break;
      }
      case 'shd': { const v = hexColor(wAttr(c, 'fill')); if (v !== undefined) out.shading = v; break; }
      default: if (!QUIET_RPR.has(c.local)) out.unmodelled.push(`w:${c.local}`);
    }
  }
  return out;
}

const ALIGN: ReadonlyMap<string, Align> = new Map([
  ['left', 'left'], ['start', 'left'], ['center', 'center'], ['right', 'right'], ['end', 'right'],
  ['both', 'justify'], ['distribute', 'justify'],
]);

export function readParaLayer(pPr: NsElement | undefined): ParaLayer {
  const out: ParaLayer = { unmodelled: [] };
  if (!pPr) return out;
  for (const c of pPr.children) {
    if (c.ns !== W) { out.unmodelled.push(displayName(c)); continue; }
    switch (c.local) {
      case 'jc': {
        const v = wAttr(c, 'val') ?? '';
        const a = ALIGN.get(v);
        if (a) out.align = a; else out.unmodelled.push(`w:jc=${v}`);
        break;
      }
      case 'spacing': {
        const before = pt(wNum(c, 'before')); if (before !== undefined) out.spaceBeforePt = before;
        const after = pt(wNum(c, 'after')); if (after !== undefined) out.spaceAfterPt = after;
        const line = wNum(c, 'line');
        if (line !== undefined) {
          const rule = wAttr(c, 'lineRule') ?? 'auto';
          out.line = rule === 'exact' ? { exactPt: line / TWIP } : rule === 'atLeast' ? { atLeastPt: line / TWIP } : { auto: line / 240 };
        }
        // Line-unit spacing and HTML-style autospacing override before/after in
        // Word and are not modelled; reported only when they say something (m2fp.9).
        for (const a of ['beforeLines', 'afterLines']) { const v = wNum(c, a); if (v !== undefined && v !== 0) out.unmodelled.push(`w:spacing@${a}`); }
        for (const a of ['beforeAutospacing', 'afterAutospacing']) if (onOffAttr(c, a)) out.unmodelled.push(`w:spacing@${a}`);
        break;
      }
      case 'contextualSpacing': if (onOff(c) !== false) out.unmodelled.push('w:contextualSpacing'); break;
      case 'ind': {
        const ind: Indent = {};
        const left = pt(wNum(c, 'left') ?? wNum(c, 'start')); if (left !== undefined) ind.leftPt = left;
        const right = pt(wNum(c, 'right') ?? wNum(c, 'end')); if (right !== undefined) ind.rightPt = right;
        // hanging outranks firstLine within one w:ind: the two are one property.
        const hang = pt(wNum(c, 'hanging'));
        const first = pt(wNum(c, 'firstLine'));
        if (hang !== undefined) ind.hangingPt = hang; else if (first !== undefined) ind.firstLinePt = first;
        out.indent = ind;
        break;
      }
      case 'tabs': {
        const list: WmlTabStop[] = [];
        for (const t of wChildren(c, 'tab')) {
          const pos = wNum(t, 'pos');
          if (pos === undefined) continue;
          const v = wAttr(t, 'val') ?? 'left';
          const val = v === 'start' ? 'left' : v === 'end' ? 'right' : v;
          if (!TAB_VALS.has(val)) { out.unmodelled.push(`w:tab@val=${v}`); continue; }
          const leader = wAttr(t, 'leader');
          list.push({ posPt: pos / TWIP, val: val as WmlTabStop['val'], ...(leader !== undefined && leader !== 'none' ? { leader } : {}) });
        }
        out.tabs = list;
        break;
      }
      case 'outlineLvl': { const n = wNum(c); if (n !== undefined) out.outlineLvl = n; break; }
      case 'numPr': {
        const id = wNum(wChild(c, 'numId')); if (id !== undefined) out.numId = id;
        const l = wNum(wChild(c, 'ilvl')); if (l !== undefined) out.ilvl = l;
        break;
      }
      default: if (!QUIET_PPR.has(c.local)) out.unmodelled.push(`w:${c.local}`);
    }
  }
  return out;
}

/** `w:defaultTabStop` from settings.xml, in points; undefined when unstated (v9j3.1). */
export function parseDefaultTabStop(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): number | undefined {
  const v = wNum(wChild(parseWml(bytes, limits), 'defaultTabStop'));
  return v !== undefined && v > 0 ? v / TWIP : undefined;
}

export function parseTheme(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): ThemeFonts {
  const root = parseNsXml(bytes, limits, { canon: canonNs });
  const scheme = nsChild(nsChild(root, A, 'themeElements'), A, 'fontScheme');
  const face = (el: NsElement | undefined, which: string): string | undefined => {
    const v = nsAttr(nsChild(el, A, which), '', 'typeface');
    return v ? v : undefined;
  };
  const pick = (el: NsElement | undefined): { latin?: string; ea?: string } => {
    const out: { latin?: string; ea?: string } = {};
    const latin = face(el, 'latin'); if (latin) out.latin = latin;
    const ea = face(el, 'ea'); if (ea) out.ea = ea;
    return out;
  };
  return { major: pick(nsChild(scheme, A, 'majorFont')), minor: pick(nsChild(scheme, A, 'minorFont')) };
}

export function emptyStyles(theme: ThemeFonts, limits: LoadLimits = LoadLimits.defaults): WmlStyles {
  return {
    byId: new Map(), defaults: { ppr: { unmodelled: [] }, rpr: { unmodelled: [] } },
    theme, maxDepth: limits.maxNestingDepth ?? Infinity,
  };
}

export function parseStyles(bytes: Uint8Array, theme: ThemeFonts, limits: LoadLimits = LoadLimits.defaults): WmlStyles {
  const root = parseWml(bytes, limits);
  if (root.ns !== W || root.local !== 'styles') throw new PdfParseError('styles.xml: the root is not w:styles');
  const dd = wChild(root, 'docDefaults');
  const byId = new Map<string, WmlStyle>();
  let defaultParagraph: string | undefined;
  let defaultCharacter: string | undefined;
  let n = 0;
  for (const s of wChildren(root, 'style')) {
    limits.enforce('maxContainerItems', ++n, 'styles');
    const id = wAttr(s, 'styleId');
    if (id === undefined || byId.has(id)) continue;
    const type = wAttr(s, 'type') ?? 'paragraph';
    const isDefault = ['1', 'true', 'on'].includes(wAttr(s, 'default') ?? '');
    byId.set(id, {
      id, type, name: wAttr(wChild(s, 'name'), 'val'), basedOn: wAttr(wChild(s, 'basedOn'), 'val'), isDefault,
      ppr: readParaLayer(wChild(s, 'pPr')), rpr: readRunLayer(wChild(s, 'rPr')),
    });
    if (isDefault && type === 'paragraph') defaultParagraph ??= id;
    if (isDefault && type === 'character') defaultCharacter ??= id;
  }
  return {
    byId, defaultParagraph, defaultCharacter, theme, maxDepth: limits.maxNestingDepth ?? Infinity,
    defaults: {
      ppr: readParaLayer(wChild(wChild(dd, 'pPrDefault'), 'pPr')),
      rpr: readRunLayer(wChild(wChild(dd, 'rPrDefault'), 'rPr')),
    },
  };
}

/** The style chain from `id`, NEAREST first. */
function chain(styles: WmlStyles, id: string | undefined, type: string): WmlStyle[] {
  const out: WmlStyle[] = [];
  const seen = new Set<string>();
  let cur = id;
  while (cur !== undefined && out.length < styles.maxDepth && !seen.has(cur)) {
    seen.add(cur);
    const s = styles.byId.get(cur);
    if (!s || s.type !== type) break;
    out.push(s);
    cur = s.basedOn;
  }
  return out;
}

function nearest<L, T>(layers: readonly L[], pick: (l: L) => T | undefined): T | undefined {
  for (const l of layers) { const v = pick(l); if (v !== undefined) return v; }
  return undefined;
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

function styleOfType(styles: WmlStyles, id: string | undefined, type: string, fallback: string | undefined): string | undefined {
  return id !== undefined && styles.byId.get(id)?.type === type ? id : fallback;
}

export function resolveParagraph(
  styles: WmlStyles, pStyle: string | undefined, direct: ParaLayer,
  levelPpr?: (numId: number, ilvl: number) => ParaLayer | undefined,
): ResolvedParagraph {
  const styleId = styleOfType(styles, pStyle, 'paragraph', styles.defaultParagraph);
  const fromStyles = chain(styles, styleId, 'paragraph').map((s) => s.ppr);
  const base = [direct, ...fromStyles, styles.defaults.ppr];
  const numId = nearest(base, (l) => l.numId);
  const ilvl = Math.min(8, Math.max(0, Math.floor(nearest(base, (l) => l.ilvl) ?? 0)));
  const level = numId !== undefined && numId > 0 && levelPpr ? levelPpr(numId, ilvl) : undefined;
  const layers = level ? [direct, level, ...fromStyles, styles.defaults.ppr] : base;

  const props: ParaProps = {};
  const align = nearest(layers, (l) => l.align); if (align) props.align = align;
  const before = nearest(layers, (l) => l.spaceBeforePt); if (before !== undefined) props.spaceBeforePt = before;
  const after = nearest(layers, (l) => l.spaceAfterPt); if (after !== undefined) props.spaceAfterPt = after;
  const line = nearest(layers, (l) => l.line); if (line) props.line = line;
  const indent: Indent = {};
  for (const k of ['leftPt', 'rightPt'] as const) {
    const v = nearest(layers, (l) => l.indent?.[k]); if (v !== undefined) indent[k] = v;
  }
  // firstLine and hanging are ONE signed property (ECMA-376 17.3.1.12): the
  // nearest layer stating either decides, and the other is dropped. Per field,
  // a Normal's firstLine survives under a list level's hanging and both reach
  // the model (final review).
  const first = nearest(layers, (l) => (l.indent?.hangingPt !== undefined || l.indent?.firstLinePt !== undefined ? l.indent : undefined));
  if (first?.hangingPt !== undefined) indent.hangingPt = first.hangingPt;
  else if (first?.firstLinePt !== undefined) indent.firstLinePt = first.firstLinePt;
  if (Object.keys(indent).length > 0) props.indent = indent;

  // (v9j3.1) Tab stops ACCUMULATE from the farthest layer to the nearest, and
  // a 'clear' removes an inherited stop at its position (ECMA-376 17.3.1.37);
  // every other paragraph property takes the nearest layer instead.
  const stops = new Map<number, WmlTabStop>();
  for (const l of [...layers].reverse()) {
    for (const t of l.tabs ?? []) {
      if (t.val === 'clear') stops.delete(t.posPt); else stops.set(t.posPt, t);
    }
  }
  const tabNotes: string[] = [];
  const tabs: ParaTab[] = [];
  for (const t of [...stops.values()].sort((a, b) => a.posPt - b.posPt)) {
    if (t.val === 'bar' || t.val === 'num') { tabNotes.push(`w:tab@val=${t.val}`); continue; }
    // A stop left of the margin has nowhere to land in a block measured from it.
    if (t.posPt < 0) { tabNotes.push('w:tab (negative position)'); continue; }
    tabs.push({ posPt: t.posPt, align: t.val as TabAlign, leader: (t.leader !== undefined ? TAB_LEADER.get(t.leader) : undefined) ?? 'none' });
  }
  if (tabs.length > 0) props.tabs = tabs;

  const outline = nearest(layers, (l) => l.outlineLvl);
  const out: ResolvedParagraph = { props, ilvl, unmodelled: dedupe([...layers.flatMap((l) => l.unmodelled), ...tabNotes]) };
  if (styleId !== undefined) {
    out.styleId = styleId;
    const name = styles.byId.get(styleId)?.name;
    if (name !== undefined) out.styleName = name;
  }
  if (outline !== undefined && outline >= 0 && outline <= 8) out.heading = outline + 1;
  if (numId !== undefined && numId > 0) out.numId = numId;
  return out;
}

function themeFace(theme: ThemeFonts, t: string): string | undefined {
  switch (t) {
    case 'majorAscii': case 'majorHAnsi': return theme.major.latin;
    case 'minorAscii': case 'minorHAnsi': return theme.minor.latin;
    case 'majorEastAsia': return theme.major.ea;
    case 'minorEastAsia': return theme.minor.ea;
    default: return undefined;
  }
}
const fontName = (theme: ThemeFonts, ref: FontRef | undefined): string | undefined =>
  ref === undefined ? undefined : (ref.theme !== undefined ? themeFace(theme, ref.theme) : undefined) ?? ref.name;

export function resolveRun(
  styles: WmlStyles, paraStyleId: string | undefined, rStyle: string | undefined, direct: RunLayer,
): ResolvedRun {
  const para = chain(styles, paraStyleId, 'paragraph').map((s) => s.rpr);
  const charId = styleOfType(styles, rStyle, 'character', styles.defaultCharacter);
  const char = chain(styles, charId, 'character').map((s) => s.rpr);
  const d = styles.defaults.rpr;
  const all = [direct, ...char, ...para, d];

  const toggle = (f: (l: RunLayer) => boolean | undefined): boolean => {
    const dv = f(direct);
    if (dv !== undefined) return dv;
    const pv = nearest(para, f);
    const cv = nearest(char, f);
    if (pv === undefined && cv === undefined) return f(d) ?? false;
    return (pv ?? false) !== (cv ?? false);
  };

  const props: RunProps = {
    bold: toggle((l) => l.bold), italic: toggle((l) => l.italic), strike: toggle((l) => l.strike),
    underline: nearest(all, (l) => l.underline) ?? false,
    sizePt: nearest(all, (l) => l.sizePt) ?? DEFAULT_SIZE_PT,
  };
  const color = nearest(all, (l) => l.color); if (color) props.color = color;
  const font = nearest(all, (l) => fontName(styles.theme, l.font)); if (font) props.font = font;
  const ea = nearest(all, (l) => fontName(styles.theme, l.eastAsiaFont)); if (ea) props.eastAsiaFont = ea;
  const highlight = nearest(all, (l) => l.highlight) ?? nearest(all, (l) => l.shading);
  if (highlight) props.highlight = highlight;
  return { props, unmodelled: dedupe(all.flatMap((l) => l.unmodelled)) };
}
