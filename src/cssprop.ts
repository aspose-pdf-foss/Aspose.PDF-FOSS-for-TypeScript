/** The CSS property table: which properties we compute, whether each
 *  inherits, what its initial value is, and how its declared value becomes a
 *  computed one.
 *
 *  Invariant: a PURE LEAF over cssvalue.js and the two parser modules' TYPES.
 *  No Document, no PDF object, no `node:` import.
 *
 *  Invariant: the set is bounded by what zch2.3, zch2.4 and zch2.6 will
 *  consume, not by CSS. 43 longhands, asserted — a property outside them is
 *  recorded as `unknown-property` for zch2.7 rather than dropped, which is
 *  what makes "we do not implement flexbox" reportable instead of invisible.
 *
 *  Invariant: `compute` returns `undefined` for a value it cannot read, and
 *  NEVER throws. An empty value is one of those: cssparse.ts reports `color:`
 *  as a valid declaration whose value is `[]`, so every helper below rejects
 *  a zero-length value before doing anything else. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import type { HtmlElement } from './htmldom.js';
import {
  trimWs, keywordOf, numberOf, lengthOf, absoluteLengthOf, colorOf,
  resolveLengthPct,
} from './cssvalue.js';
import type { Color, LengthPct } from './cssvalue.js';

export type LineHeight = 'normal' | { number: number } | { px: number };
export type Auto<T> = T | 'auto';
export type DecorationLine = 'underline' | 'overline' | 'line-through';

export type BorderStyle = 'none' | 'hidden' | 'solid' | 'dotted' | 'dashed'
  | 'double' | 'groove' | 'ridge' | 'inset' | 'outset';

export interface ComputedStyle {
  fontFamily: string[];
  fontSize: number;
  fontStyle: 'normal' | 'italic' | 'oblique';
  fontWeight: number;
  lineHeight: LineHeight;
  color: Color;
  backgroundColor: Color;
  textAlign: 'start' | 'end' | 'left' | 'right' | 'center' | 'justify';
  textDecorationLine: DecorationLine[];
  textDecorationColor: Color;
  textDecorationStyle: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';
  textIndent: LengthPct;
  whiteSpace: 'normal' | 'pre' | 'nowrap' | 'pre-wrap' | 'pre-line';
  verticalAlign: 'baseline' | 'sub' | 'super' | 'top' | 'middle' | 'bottom'
    | 'text-top' | 'text-bottom';
  display: 'inline' | 'block' | 'inline-block' | 'list-item' | 'none'
    | 'table' | 'table-row-group' | 'table-header-group' | 'table-footer-group'
    | 'table-row' | 'table-cell' | 'table-caption';
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
  width: Auto<LengthPct>;
  height: Auto<LengthPct>;
  marginTop: Auto<LengthPct>;
  marginRight: Auto<LengthPct>;
  marginBottom: Auto<LengthPct>;
  marginLeft: Auto<LengthPct>;
  paddingTop: LengthPct;
  paddingRight: LengthPct;
  paddingBottom: LengthPct;
  paddingLeft: LengthPct;
  borderTopWidth: number;
  borderRightWidth: number;
  borderBottomWidth: number;
  borderLeftWidth: number;
  borderTopStyle: BorderStyle;
  borderRightStyle: BorderStyle;
  borderBottomStyle: BorderStyle;
  borderLeftStyle: BorderStyle;
  borderTopColor: Color;
  borderRightColor: Color;
  borderBottomColor: Color;
  borderLeftColor: Color;
  listStyleType: string;
  listStylePosition: 'outside' | 'inside';
  borderCollapse: 'separate' | 'collapse';
  borderSpacing: number;
}

/** What relative values resolve against, for ONE element.
 *
 *  `fontSize` is that element's own computed font-size and `parentFontSize`
 *  is its parent's. Both are present because `font-size` is the one property
 *  whose `em` resolves against the parent while every other property's
 *  resolves against the element — see csscompute.ts, the only caller that
 *  makes the distinction. */
export interface PropContext {
  fontSize: number;
  parentFontSize: number;
  rootFontSize: number;
  parentWeight: number;
  /** The element's ALREADY-computed `color`, for `currentColor`. This is why
   *  `color` is computed before every property that can name it. */
  color: Color;
}

export interface PropDef {
  key: keyof ComputedStyle;
  inherited: boolean;
  initial: unknown;
  compute(v: CssValue[], ctx: PropContext): unknown;
}

export interface UnsupportedDeclaration {
  /** null for a sheet-level construct — an at-rule belongs to no element. */
  el: HtmlElement | null;
  /** A property name, or '@import'/'@media' naming itself. */
  property: string;
  /** The source text, so a caller can report what it could not render. */
  value: string;
  /** `undefined-var` names a var() referencing a custom property nothing
   *  defines. `var-cycle` is a reference cycle among custom properties, OR an
   *  expansion that exceeded cssvar.ts's budget — a caller's action is the
   *  same for both, and a third reason for input no real document produces
   *  would be noise. */
  reason: 'unknown-property' | 'unparsable-value' | 'unsupported-at-rule'
        | 'unsupported-media-feature' | 'undefined-var' | 'var-cycle';
}

/** The initial value of every length-percentage property here.
 *
 *  A named constant rather than nine object literals, and TYPED rather than
 *  left to `PropDef.initial`'s `unknown` — which is what let nine of them go
 *  on saying `{ px: 0 }` after LengthPct gained its `pct` field, with the
 *  compiler silent and every box in every document coming out NaN wide. */
const ZERO_LENGTH: LengthPct = { px: 0, pct: 0 };

const BLACK: Color = { rgb: [0, 0, 0], a: 1 };
const TRANSPARENT: Color = { rgb: [0, 0, 0], a: 0 };

/** The seven absolute font-size keywords, medium anchored at 16px. */
export const FONT_SIZE_KEYWORDS: Readonly<Record<string, number>> = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16,
  large: 18, 'x-large': 24, 'xx-large': 32,
};

/** The ratio `smaller`/`larger` scale by. The spec suggests roughly 1.2 and
 *  does not pin it, which is why the oracle excludes both keywords. */
const FONT_SCALE = 1.2;

// ---- helper factories ------------------------------------------------------
// Each returns a `compute`. They exist so the 43 rows below carry only what
// differs per property; a grammar written out 43 times is 43 chances to
// disagree with itself.

/** One of a fixed set of keywords. */
function kw<T extends string>(...allowed: T[]): PropDef['compute'] {
  const set = new Set<string>(allowed);
  return (v) => {
    const k = keywordOf(v);
    return k !== undefined && set.has(k) ? k : undefined;
  };
}

/** A length or percentage. */
function len(): PropDef['compute'] {
  return (v, c) => lengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
}

/** A length or percentage, or the keyword `auto`. */
function lenAuto(): PropDef['compute'] {
  return (v, c) => {
    if (keywordOf(v) === 'auto') return 'auto';
    return lengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
  };
}

/** A length with no percentage form. */
function absLen(): PropDef['compute'] {
  return (v, c) =>
    absoluteLengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
}

/** A colour, with `currentColor` resolved against the context. */
function col(): PropDef['compute'] {
  return (v, c) => {
    const x = colorOf(v);
    return x === 'currentcolor' ? c.color : x;
  };
}

/** The three border-width keywords, or a length. */
function borderWidth(): PropDef['compute'] {
  const KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
  return (v, c) => {
    const k = keywordOf(v);
    if (k !== undefined) return KEYWORDS[k];
    return absoluteLengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
  };
}

const BORDER_STYLES: BorderStyle[] = ['none', 'hidden', 'solid', 'dotted',
  'dashed', 'double', 'groove', 'ridge', 'inset', 'outset'];

// ---- the per-property computes that are not a plain factory ----------------

const computeFontSize: PropDef['compute'] = (v, c) => {
  const k = keywordOf(v);
  if (k !== undefined) {
    const abs = FONT_SIZE_KEYWORDS[k];
    if (abs !== undefined) return abs;
    if (k === 'larger') return c.parentFontSize * FONT_SCALE;
    if (k === 'smaller') return c.parentFontSize / FONT_SCALE;
    return undefined;
  }
  // BOTH relative forms resolve against the PARENT here, and this is the one
  // property where that is true. `em` elsewhere resolves against the element's
  // own size; getting this row wrong compounds down the tree, so a nested
  // document ends up off by a factor rather than by a pixel.
  const l = lengthOf(v, { fontSize: c.parentFontSize, rootFontSize: c.rootFontSize });
  if (l === undefined) return undefined;
  const px = resolveLengthPct(l, c.parentFontSize);
  return px >= 0 ? px : undefined;
};

const computeFontWeight: PropDef['compute'] = (v, c) => {
  const n = numberOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
  if (n !== undefined) return n >= 1 && n <= 1000 ? n : undefined;
  const k = keywordOf(v);
  if (k === 'normal') return 400;
  if (k === 'bold') return 700;
  // Relative to the PARENT's computed weight, via CSS Fonts 4's table
  // collapsed to its two useful steps for the weights documents actually use.
  if (k === 'bolder') return c.parentWeight < 350 ? 400 : c.parentWeight < 550 ? 700 : 900;
  if (k === 'lighter') return c.parentWeight < 550 ? 100 : c.parentWeight < 750 ? 400 : 700;
  return undefined;
};

/** A comma-separated family list. A quoted family keeps its spaces; an
 *  unquoted one may be several idents (`Times New Roman`) and is rejoined
 *  with single spaces. Case is KEPT: a family name is matched by
 *  fontmatch.ts, which has its own folding rule. */
const computeFontFamily: PropDef['compute'] = (v) => {
  const t = trimWs(v);
  if (t.length === 0) return undefined;
  const out: string[] = [];
  let part: string[] = [];
  const flush = (): boolean => {
    if (part.length === 0) return false;
    out.push(part.join(' '));
    part = [];
    return true;
  };
  for (const x of t) {
    const tok = x as CssToken;
    if (tok.kind === 'whitespace') continue;
    if (tok.kind === 'comma') { if (!flush()) return undefined; continue; }
    if (tok.kind === 'string') { part.push(tok.value); continue; }
    if (tok.kind === 'ident') { part.push(tok.value); continue; }
    return undefined;
  }
  if (!flush()) return undefined;
  return out;
};

/** A NUMBER stays a number and a PERCENTAGE becomes px. They are different
 *  values, not two spellings: a number inherits as a number so every
 *  descendant multiplies by its own size, while a percentage inherits as the
 *  px it already computed to. A single-font-size document cannot tell them
 *  apart, which is why the fixture for this nests a heading. */
const computeLineHeight: PropDef['compute'] = (v, c) => {
  if (keywordOf(v) === 'normal') return 'normal';
  const n = numberOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
  if (n !== undefined) return n >= 0 ? { number: n } : undefined;
  const l = lengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
  if (l === undefined) return undefined;
  return { px: resolveLengthPct(l, c.fontSize) };
};

/** A SET of lines in any order, or `none` as the empty set. A repeat is a
 *  syntax error rather than a silently deduplicated value. */
const computeDecorationLine: PropDef['compute'] = (v) => {
  const t = trimWs(v);
  if (t.length === 0) return undefined;
  if (keywordOf(v) === 'none') return [];
  const order: DecorationLine[] = ['underline', 'overline', 'line-through'];
  const seen = new Set<string>();
  for (const x of t) {
    const tok = x as CssToken;
    if (tok.kind === 'whitespace') continue;
    if (tok.kind !== 'ident') return undefined;
    const k = tok.value.toLowerCase();
    if (!order.includes(k as DecorationLine) || seen.has(k)) return undefined;
    seen.add(k);
  }
  if (seen.size === 0) return undefined;
  return order.filter((o) => seen.has(o));
};

/** `list-style-type` takes a long open-ended keyword list plus a string
 *  counter, so it is stored as the raw lowercased keyword and validated
 *  against the small set zch2.4 can actually draw. */
const LIST_TYPES = ['disc', 'circle', 'square', 'decimal', 'decimal-leading-zero',
  'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman', 'none'];

// ---- the table -------------------------------------------------------------

function def(
  key: keyof ComputedStyle, inherited: boolean, initial: unknown,
  compute: PropDef['compute'],
): PropDef {
  return { key, inherited, initial, compute };
}

export const PROPERTIES: ReadonlyMap<string, PropDef> = new Map<string, PropDef>([
  ['font-family', def('fontFamily', true, ['serif'], computeFontFamily)],
  ['font-size', def('fontSize', true, 16, computeFontSize)],
  ['font-style', def('fontStyle', true, 'normal', kw('normal', 'italic', 'oblique'))],
  ['font-weight', def('fontWeight', true, 400, computeFontWeight)],
  ['line-height', def('lineHeight', true, 'normal', computeLineHeight)],
  ['color', def('color', true, BLACK, col())],
  ['background-color', def('backgroundColor', false, TRANSPARENT, col())],
  ['text-align', def('textAlign', true, 'start',
    kw('start', 'end', 'left', 'right', 'center', 'justify'))],
  ['text-decoration-line', def('textDecorationLine', false, [], computeDecorationLine)],
  ['text-decoration-color', def('textDecorationColor', false, 'currentcolor', col())],
  ['text-decoration-style', def('textDecorationStyle', false, 'solid',
    kw('solid', 'double', 'dotted', 'dashed', 'wavy'))],
  ['text-indent', def('textIndent', true, ZERO_LENGTH, len())],
  ['white-space', def('whiteSpace', true, 'normal',
    kw('normal', 'pre', 'nowrap', 'pre-wrap', 'pre-line'))],
  ['vertical-align', def('verticalAlign', false, 'baseline',
    kw('baseline', 'sub', 'super', 'top', 'middle', 'bottom', 'text-top', 'text-bottom'))],
  ['display', def('display', false, 'inline',
    kw('inline', 'block', 'inline-block', 'list-item', 'none', 'table',
      'table-row-group', 'table-header-group', 'table-footer-group',
      'table-row', 'table-cell', 'table-caption'))],
  ['float', def('float', false, 'none', kw('none', 'left', 'right'))],
  ['clear', def('clear', false, 'none', kw('none', 'left', 'right', 'both'))],
  ['width', def('width', false, 'auto', lenAuto())],
  ['height', def('height', false, 'auto', lenAuto())],
  ['margin-top', def('marginTop', false, ZERO_LENGTH, lenAuto())],
  ['margin-right', def('marginRight', false, ZERO_LENGTH, lenAuto())],
  ['margin-bottom', def('marginBottom', false, ZERO_LENGTH, lenAuto())],
  ['margin-left', def('marginLeft', false, ZERO_LENGTH, lenAuto())],
  ['padding-top', def('paddingTop', false, ZERO_LENGTH, len())],
  ['padding-right', def('paddingRight', false, ZERO_LENGTH, len())],
  ['padding-bottom', def('paddingBottom', false, ZERO_LENGTH, len())],
  ['padding-left', def('paddingLeft', false, ZERO_LENGTH, len())],
  ['border-top-width', def('borderTopWidth', false, 3, borderWidth())],
  ['border-right-width', def('borderRightWidth', false, 3, borderWidth())],
  ['border-bottom-width', def('borderBottomWidth', false, 3, borderWidth())],
  ['border-left-width', def('borderLeftWidth', false, 3, borderWidth())],
  ['border-top-style', def('borderTopStyle', false, 'none', kw(...BORDER_STYLES))],
  ['border-right-style', def('borderRightStyle', false, 'none', kw(...BORDER_STYLES))],
  ['border-bottom-style', def('borderBottomStyle', false, 'none', kw(...BORDER_STYLES))],
  ['border-left-style', def('borderLeftStyle', false, 'none', kw(...BORDER_STYLES))],
  ['border-top-color', def('borderTopColor', false, 'currentcolor', col())],
  ['border-right-color', def('borderRightColor', false, 'currentcolor', col())],
  ['border-bottom-color', def('borderBottomColor', false, 'currentcolor', col())],
  ['border-left-color', def('borderLeftColor', false, 'currentcolor', col())],
  ['list-style-type', def('listStyleType', true, 'disc', kw(...LIST_TYPES))],
  ['list-style-position', def('listStylePosition', true, 'outside', kw('outside', 'inside'))],
  ['border-collapse', def('borderCollapse', true, 'separate', kw('separate', 'collapse'))],
  ['border-spacing', def('borderSpacing', true, 0, absLen())],
]);

/** Every property at its initial value.
 *
 *  The three `'currentcolor'` initials are resolved by csscompute.ts against
 *  the element's own computed `color`, exactly as a declared `currentColor`
 *  is — one rule rather than two. */
export const INITIAL_STYLE: ComputedStyle = (() => {
  const s: Record<string, unknown> = {};
  for (const d of PROPERTIES.values()) {
    s[d.key] = d.initial === 'currentcolor' ? BLACK : d.initial;
  }
  return s as unknown as ComputedStyle;
})();
