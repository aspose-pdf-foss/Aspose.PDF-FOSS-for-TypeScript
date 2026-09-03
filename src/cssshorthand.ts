/** Shorthand → longhand expansion.
 *
 *  Invariant: a PURE LEAF over cssvalue.js and cssprop.js. No Document, no
 *  PDF object, no `node:` import. It never throws: a value a shorthand's
 *  grammar rejects is `undefined`, and the caller records it for zch2.7.
 *
 *  Invariant: a shorthand sets EVERY longhand it governs, including the ones
 *  the author did not mention — `border: 1px` resets style and colour. That
 *  is modelled by emitting a synthetic `initial` ident for the unmentioned
 *  ones rather than by a second concept, so the CSS-wide keyword machinery
 *  cssvalue.ts already has does the work and there is one reset rule here
 *  rather than two.
 *
 *  Invariant: a CSS-wide keyword on a shorthand passes straight through to
 *  every longhand. `margin: inherit` means four inheriting sides; handling it
 *  inside each shorthand's own grammar would be four more places to get it
 *  wrong.
 *
 *  Invariant: it is its own module rather than a section of cssprop.ts
 *  because expansion is LOGIC where that table is DATA — and because `font`
 *  alone, with its reorderable prefix, its slash-joined size/line-height pair
 *  and the system keywords it must refuse, is larger than several rows. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import { trimWs, keywordOf, colorOf, cssWideOf } from './cssvalue.js';
import { FONT_SIZE_KEYWORDS } from './cssprop.js';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** A synthetic value meaning "reset this longhand". */
const INITIAL: CssValue[] = [{ kind: 'ident', value: 'initial' } as CssToken];

export const SHORTHANDS: ReadonlySet<string> = new Set([
  'margin', 'padding',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-width', 'border-style', 'border-color',
  'font', 'background', 'list-style', 'text-decoration',
]);

/** Split a value into whitespace-delimited parts. Commas are KEPT inside a
 *  part, because a font family list is one part with commas in it. */
function parts(v: CssValue[]): CssValue[][] {
  const out: CssValue[][] = [];
  let cur: CssValue[] = [];
  for (const x of v) {
    if ((x as CssToken).kind === 'whitespace') {
      if (cur.length > 0) { out.push(cur); cur = []; }
      continue;
    }
    cur.push(x);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** The 1-to-4-value box rule: 1 → all, 2 → TB/LR, 3 → T/LR/B, 4 → clockwise. */
function boxOf(p: CssValue[][]): [CssValue[], CssValue[], CssValue[], CssValue[]] | undefined {
  const [a, b, c, d] = p;
  if (a === undefined) return undefined;
  if (p.length === 1) return [a, a, a, a];
  if (p.length === 2 && b !== undefined) return [a, b, a, b];
  if (p.length === 3 && b !== undefined && c !== undefined) return [a, b, c, b];
  if (p.length === 4 && b !== undefined && c !== undefined && d !== undefined)
    return [a, b, c, d];
  return undefined;
}

function box(prefix: string, suffix: string, p: CssValue[][]): [string, CssValue[]][] | undefined {
  const b = boxOf(p);
  if (b === undefined) return undefined;
  return SIDES.map((s, i) => [`${prefix}${s}${suffix}`, b[i] as CssValue[]]);
}

const BORDER_STYLE_WORDS = new Set(['none', 'hidden', 'solid', 'dotted', 'dashed',
  'double', 'groove', 'ridge', 'inset', 'outset']);
const BORDER_WIDTH_WORDS = new Set(['thin', 'medium', 'thick']);

/** Classify the up-to-three components of a `border` value, in any order. */
function borderParts(p: CssValue[][]):
{ width?: CssValue[]; style?: CssValue[]; color?: CssValue[] } | undefined {
  if (p.length === 0 || p.length > 3) return undefined;
  const out: { width?: CssValue[]; style?: CssValue[]; color?: CssValue[] } = {};
  for (const part of p) {
    const k = keywordOf(part);
    if (k !== undefined && BORDER_STYLE_WORDS.has(k)) {
      if (out.style !== undefined) return undefined;
      out.style = part;
      continue;
    }
    if (k !== undefined && BORDER_WIDTH_WORDS.has(k)) {
      if (out.width !== undefined) return undefined;
      out.width = part;
      continue;
    }
    const t = part[0] as CssToken | undefined;
    if (part.length === 1 && t !== undefined
      && (t.kind === 'dimension' || (t.kind === 'number' && t.value === 0))) {
      if (out.width !== undefined) return undefined;
      out.width = part;
      continue;
    }
    if (colorOf(part) !== undefined) {
      if (out.color !== undefined) return undefined;
      out.color = part;
      continue;
    }
    return undefined;                       // a component we cannot classify
  }
  return out;
}

function borderSides(sides: readonly string[], p: CssValue[][]):
[string, CssValue[]][] | undefined {
  const c = borderParts(p);
  if (c === undefined) return undefined;
  const out: [string, CssValue[]][] = [];
  for (const s of sides) {
    out.push([`border-${s}-width`, c.width ?? INITIAL]);
    out.push([`border-${s}-style`, c.style ?? INITIAL]);
    out.push([`border-${s}-color`, c.color ?? INITIAL]);
  }
  return out;
}

const FONT_SYSTEM = new Set(['caption', 'icon', 'menu', 'message-box',
  'small-caption', 'status-bar']);
const FONT_STYLE_WORDS = new Set(['italic', 'oblique']);
const FONT_WEIGHT_WORDS = new Set(['bold', 'bolder', 'lighter']);
const FONT_VARIANT_WORDS = new Set(['small-caps']);

/** `[style || variant || weight] <size>[/<line-height>] <family>`.
 *
 *  Worked at TOKEN level rather than over whitespace-delimited parts, because
 *  `12px/1.5` is one part containing three tokens — measured, not assumed. */
function expandFont(v: CssValue[]): [string, CssValue[]][] | undefined {
  const t = trimWs(v);
  if (t.length === 0) return undefined;

  const lone = keywordOf(v);
  // A system font names a platform face we cannot resolve. Refusing records
  // it for zch2.7; guessing would set a family the author never named.
  if (lone !== undefined && FONT_SYSTEM.has(lone)) return undefined;

  let style: CssValue[] | undefined;
  let weight: CssValue[] | undefined;
  let i = 0;

  // The reorderable prefix. `normal` is legal for style, variant and weight
  // alike and means the initial for all three, so it is consumed and dropped.
  for (; i < t.length; i++) {
    const x = t[i] as CssToken;
    if (x.kind === 'whitespace') continue;
    if (x.kind === 'ident') {
      const k = x.value.toLowerCase();
      if (k === 'normal') continue;
      if (FONT_STYLE_WORDS.has(k)) {
        if (style !== undefined) return undefined;
        style = [x];
        continue;
      }
      if (FONT_WEIGHT_WORDS.has(k)) {
        if (weight !== undefined) return undefined;
        weight = [x];
        continue;
      }
      if (FONT_VARIANT_WORDS.has(k)) continue;   // font-variant is out of scope
      break;                                     // must be the size keyword
    }
    if (x.kind === 'number' && x.value >= 1 && x.value <= 1000) {
      if (weight !== undefined) return undefined;
      weight = [x];
      continue;
    }
    break;                                       // must be the size
  }

  // The size.
  const sizeTok = t[i] as CssToken | undefined;
  if (sizeTok === undefined) return undefined;
  const sizeOk = sizeTok.kind === 'dimension' || sizeTok.kind === 'percentage'
    || (sizeTok.kind === 'ident'
      && Object.prototype.hasOwnProperty.call(FONT_SIZE_KEYWORDS, sizeTok.value.toLowerCase()));
  if (!sizeOk) return undefined;
  const size: CssValue[] = [sizeTok];
  i++;

  // The optional `/ <line-height>`, whose slash may or may not be spaced.
  let lineHeight: CssValue[] | undefined;
  let j = i;
  while (j < t.length && (t[j] as CssToken).kind === 'whitespace') j++;
  const slash = t[j] as CssToken | undefined;
  if (slash !== undefined && slash.kind === 'delim' && slash.value === '/') {
    j++;
    while (j < t.length && (t[j] as CssToken).kind === 'whitespace') j++;
    const lh = t[j] as CssToken | undefined;
    if (lh === undefined) return undefined;
    lineHeight = [lh];
    i = j + 1;
  }

  const family = trimWs(t.slice(i));
  if (family.length === 0) return undefined;

  return [
    ['font-style', style ?? INITIAL],
    ['font-weight', weight ?? INITIAL],
    ['font-size', size],
    ['line-height', lineHeight ?? INITIAL],
    ['font-family', family],
  ];
}

const LIST_POSITION_WORDS = new Set(['inside', 'outside']);

function expandListStyle(p: CssValue[][]): [string, CssValue[]][] | undefined {
  if (p.length === 0 || p.length > 2) return undefined;
  let type: CssValue[] | undefined;
  let position: CssValue[] | undefined;
  for (const part of p) {
    const k = keywordOf(part);
    if (k === undefined) return undefined;
    if (LIST_POSITION_WORDS.has(k)) {
      if (position !== undefined) return undefined;
      position = part;
      continue;
    }
    // `none` is legal for the type AND the image. The image is out of scope,
    // so the type is the only reading that means anything here.
    if (type !== undefined) return undefined;
    type = part;
  }
  return [['list-style-type', type ?? INITIAL], ['list-style-position', position ?? INITIAL]];
}

const DECORATION_LINE_WORDS = new Set(['none', 'underline', 'overline', 'line-through']);
const DECORATION_STYLE_WORDS = new Set(['solid', 'double', 'dotted', 'dashed', 'wavy']);

function expandTextDecoration(p: CssValue[][]): [string, CssValue[]][] | undefined {
  if (p.length === 0) return undefined;
  const line: CssValue[] = [];
  let style: CssValue[] | undefined;
  let color: CssValue[] | undefined;
  for (const part of p) {
    const k = keywordOf(part);
    if (k !== undefined && DECORATION_LINE_WORDS.has(k)) {
      if (line.length > 0) line.push({ kind: 'whitespace' } as CssToken);
      line.push(...part);
      continue;
    }
    if (k !== undefined && DECORATION_STYLE_WORDS.has(k)) {
      if (style !== undefined) return undefined;
      style = part;
      continue;
    }
    if (colorOf(part) !== undefined) {
      if (color !== undefined) return undefined;
      color = part;
      continue;
    }
    return undefined;
  }
  return [
    ['text-decoration-line', line.length > 0 ? line : INITIAL],
    ['text-decoration-style', style ?? INITIAL],
    ['text-decoration-color', color ?? INITIAL],
  ];
}

/** The longhands each shorthand governs.
 *
 *  Two consumers: the CSS-wide-keyword pass-through below, and cssvar.ts,
 *  which emits one pending-substitution entry per governed longhand when a
 *  shorthand's value contains a `var()`. */
export const GOVERNS: Record<string, string[]> = {
  margin: SIDES.map((s) => `margin-${s}`),
  padding: SIDES.map((s) => `padding-${s}`),
  'border-width': SIDES.map((s) => `border-${s}-width`),
  'border-style': SIDES.map((s) => `border-${s}-style`),
  'border-color': SIDES.map((s) => `border-${s}-color`),
  border: SIDES.flatMap((s) =>
    [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  font: ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'],
  background: ['background-color'],
  'list-style': ['list-style-type', 'list-style-position'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style',
    'text-decoration-color'],
};

export function expandShorthand(
  name: string, v: CssValue[],
): [string, CssValue[]][] | undefined {
  const n = name.toLowerCase();
  if (!SHORTHANDS.has(n)) return undefined;

  // A CSS-wide keyword goes to every longhand this shorthand governs, before
  // the shorthand's own grammar is consulted at all.
  if (cssWideOf(v) !== undefined) {
    const value = trimWs(v);
    return (GOVERNS[n] as string[]).map((k) => [k, value]);
  }

  const p = parts(trimWs(v));
  if (p.length === 0) return undefined;

  switch (n) {
    case 'margin': return box('margin-', '', p);
    case 'padding': return box('padding-', '', p);
    case 'border-width': return box('border-', '-width', p);
    case 'border-style': return box('border-', '-style', p);
    case 'border-color': return box('border-', '-color', p);
    case 'border': return borderSides(SIDES, p);
    case 'border-top': return borderSides(['top'], p);
    case 'border-right': return borderSides(['right'], p);
    case 'border-bottom': return borderSides(['bottom'], p);
    case 'border-left': return borderSides(['left'], p);
    case 'font': return expandFont(v);
    // Only the colour component is in scope. A background carrying an image
    // is REFUSED whole rather than reduced to its colour: taking the red out
    // of `red url(x.png)` renders a flat panel where the author wrote a
    // picture, and refusing records it for zch2.7.
    case 'background': {
      const c = trimWs(v);
      return colorOf(c) === undefined ? undefined : [['background-color', c]];
    }
    case 'list-style': return expandListStyle(p);
    case 'text-decoration': return expandTextDecoration(p);
    default: return undefined;
  }
}
