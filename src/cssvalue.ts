/** CSS values, over the component values cssparse.ts produces.
 *
 *  Invariant: a PURE LEAF. It imports cssparse.js and csstoken.js for TYPES,
 *  colornames.js for data and csscalc.js for the math functions, and nothing
 *  else — no Document, no PDF object, no `node:` import, no htmldom.js. It
 *  never re-reads a character: the tokenizer's output is the only input, the
 *  rule cssparse.ts and cssselect.ts both hold.
 *
 *  Invariant: NEVER throws. A value it cannot read is `undefined`, and the
 *  caller records it for zch2.7 rather than dropping it silently. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import { NAMED_COLORS } from './colornames.js';
import { mathValueOf, dimensionPx, evalNode } from './csscalc.js';
import type { CalcNode, LengthContext } from './csscalc.js';

export type { LengthContext };

/** A length-percentage.
 *
 *  ONE shape rather than a `{px} | {pct}` union, and the change is forced by
 *  the math functions: CSS Values 4 §10.9 reduces every length-percentage
 *  math function to `calc(A + B%)`, which `calc(100% - 20px)` is and which
 *  neither arm of a union can hold. A THIRD arm would have been worse than
 *  converting — every `'px' in v` test already written would have matched it
 *  and silently dropped the percentage.
 *
 *  `expr` is the rare second arm, for the one thing that will not reduce: a
 *  `min()`/`max()`/`clamp()` a percentage reaches, whose winner depends on
 *  the basis. Read it through `resolveLengthPct` and `fixedPx` rather than by
 *  hand, which is what keeps one owner for "resolve a length-percentage". */
export type LengthPct = { px: number; pct: number } | { expr: CalcNode };

export type CssWide = 'inherit' | 'initial' | 'unset' | 'revert';

/** Resolve against a percentage BASIS — the containing block's width for a
 *  box property, the relevant font size for `font-size` and `line-height`. */
export function resolveLengthPct(v: LengthPct, basis: number): number {
  return 'expr' in v ? evalNode(v.expr, basis) : v.px + (v.pct * basis) / 100;
}

/** The value when it does not depend on the basis, and undefined when it
 *  does. This is the question a border width asks, and the one a percentage
 *  height asks before reporting 0. */
export function fixedPx(v: LengthPct): number | undefined {
  return 'expr' in v || v.pct !== 0 ? undefined : v.px;
}

function isWs(v: CssValue | undefined): boolean {
  return v !== undefined && (v as CssToken).kind === 'whitespace';
}

/** Strip whitespace at both ends of a declaration value.
 *
 *  Both ends, and neither is optional: cssparse.ts hands every value a
 *  LEADING whitespace token (from after the colon), and an `!important`
 *  declaration keeps a TRAILING one (from before the bang it truncated at).
 *  A consumer matching on `value.length` is wrong on both without this. */
export function trimWs(v: CssValue[]): CssValue[] {
  let a = 0;
  let b = v.length;
  while (a < b && isWs(v[a])) a++;
  while (b > a && isWs(v[b - 1])) b--;
  return v.slice(a, b);
}

/** A lone ident, ASCII-lowercased. Undefined for anything else, INCLUDING a
 *  two-token value — `keywordOf` is how a caller asks "is this exactly this
 *  one word", so `auto auto` must not read as `auto`. */
export function keywordOf(v: CssValue[]): string | undefined {
  const t = trimWs(v);
  if (t.length !== 1) return undefined;
  const x = t[0] as CssToken;
  return x.kind === 'ident' ? x.value.toLowerCase() : undefined;
}

const CSS_WIDE = new Set<string>(['inherit', 'initial', 'unset', 'revert']);

/** The CSS-wide keywords, valid for EVERY property, so a caller recognises
 *  them before consulting the property's own grammar. */
export function cssWideOf(v: CssValue[]): CssWide | undefined {
  const k = keywordOf(v);
  return k !== undefined && CSS_WIDE.has(k) ? (k as CssWide) : undefined;
}

/** A number, or a NUMBER-TYPED math function.
 *
 *  It takes a `LengthContext` although a number-typed result provably cannot
 *  contain a dimension — every rule in csscalc.ts refuses to mix one into a
 *  number — because the parse has to resolve `1em` before it can decide the
 *  expression is length-typed and refuse it. A signature that hid that would
 *  be one more thing to remember if the type rules ever widen. */
export function numberOf(v: CssValue[], ctx: LengthContext): number | undefined {
  const t = trimWs(v);
  if (t.length !== 1) return undefined;
  const x = t[0] as CssValue;
  if ((x as CssToken).kind === 'number') return (x as CssToken & { value: number }).value;
  const m = mathValueOf(x, ctx);
  return m !== undefined && 'num' in m ? m.num : undefined;
}

export function lengthOf(v: CssValue[], ctx: LengthContext): LengthPct | undefined {
  const t = trimWs(v);
  if (t.length !== 1) return undefined;
  const x = t[0] as CssValue;

  // A math function is ONE component value, so it needs no relaxation of the
  // single-value rule above — and a NUMBER-typed one is refused here for the
  // same reason a bare `5` is, which falls out of csscalc.ts's type algebra
  // rather than needing a rule of its own.
  if (x.kind === 'function') {
    const m = mathValueOf(x, ctx);
    if (m === undefined || !('lp' in m)) return undefined;
    return m.lp.kind === 'lin' ? { px: m.lp.px, pct: m.lp.pct } : { expr: m.lp };
  }

  const tok = x as CssToken;
  if (tok.kind === 'percentage') return { px: 0, pct: tok.value };

  // A bare ZERO is a length and no other bare number is. `margin: 0` is valid
  // CSS, `margin: 5` is not, and accepting any number turns a typo into a
  // length nobody wrote.
  if (tok.kind === 'number') return tok.value === 0 ? { px: tok.value, pct: 0 } : undefined;

  if (tok.kind !== 'dimension') return undefined;
  const px = dimensionPx(tok.value, tok.unit, ctx);
  return px === undefined ? undefined : { px, pct: 0 };
}

/** `lengthOf` for the properties that take no percentage — a border width, a
 *  border spacing. A percentage there has nothing to resolve against even at
 *  layout time, so it is refused here rather than passed on. */
export function absoluteLengthOf(v: CssValue[], ctx: LengthContext): number | undefined {
  const l = lengthOf(v, ctx);
  return l === undefined ? undefined : fixedPx(l);
}

// ---- colours ---------------------------------------------------------------

export interface Color {
  /** Components 0..1, matching the repo's convention everywhere else. */
  rgb: [number, number, number];
  /** 0..1. `transparent` is `a: 0` rather than a separate absent case, so
   *  nothing downstream has to special-case "no colour" beside "a colour". */
  a: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function hexPair(s: string): number {
  return parseInt(s, 16) / 255;
}

/** A `hash` token's hex digits.
 *
 *  It IGNORES the token's `id` flag, and that is the whole rule. csstoken.ts
 *  sets `id: true` only when the name is an identifier, so `#123456` and
 *  `#1a2b3c` arrive as `id: false` while `#abc` and `#a1b2c3` arrive as
 *  `id: true`. cssselect.ts REQUIRES the flag, correctly — `#123456` is not a
 *  valid id selector. A colour must ignore it, or the commonest spelling of a
 *  hex colour there is silently stops parsing. Two modules, opposite rules,
 *  one token: do not copy either rule into the other. */
function fromHex(hex: string): Color | undefined {
  const h = hex.toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) return undefined;
  if (h.length === 3 || h.length === 4) {
    const d = (i: number): string => (h[i] as string) + (h[i] as string);
    return {
      rgb: [hexPair(d(0)), hexPair(d(1)), hexPair(d(2))],
      a: h.length === 4 ? hexPair(d(3)) : 1,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      rgb: [hexPair(h.slice(0, 2)), hexPair(h.slice(2, 4)), hexPair(h.slice(4, 6))],
      a: h.length === 8 ? hexPair(h.slice(6, 8)) : 1,
    };
  }
  return undefined;
}

interface FnArg { n: number; pct: boolean; deg: boolean }

/** The numeric arguments of a colour function, in order, with the separators
 *  discarded.
 *
 *  Commas, whitespace and the `/` alpha delimiter are all just separators
 *  here. That collapses `rgb(1,2,3)`, `rgb(1 2 3)`, `rgb(1 2 3 / .5)` and
 *  `rgba(1,2,3,.5)` into one walk, at the cost of accepting a few separator
 *  spellings CSS does not — which costs nothing, since a stylesheet that
 *  reaches this function was written by an author, not an attacker. */
function fnArgs(args: CssValue[]): FnArg[] | undefined {
  const out: FnArg[] = [];
  for (const a of args) {
    const t = a as CssToken;
    if (t.kind === 'whitespace' || t.kind === 'comma') continue;
    if (t.kind === 'delim' && t.value === '/') continue;
    if (t.kind === 'number') { out.push({ n: t.value, pct: false, deg: false }); continue; }
    if (t.kind === 'percentage') { out.push({ n: t.value, pct: true, deg: false }); continue; }
    if (t.kind === 'dimension' && t.unit.toLowerCase() === 'deg') {
      out.push({ n: t.value, pct: false, deg: true });
      continue;
    }
    return undefined;                     // anything else: not a colour we read
  }
  return out;
}

/** HSL to RGB, CSS Color 4 §7. Hue is wrapped into 0..360 first, so
 *  `hsl(480 …)` is `hsl(120 …)` and `hsl(-120 …)` is `hsl(240 …)`. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const lig = clamp01(l);
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12;
    const a = sat * Math.min(lig, 1 - lig);
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Parse a colour. Returns the sentinel `'currentcolor'` for `currentColor`,
 *  which names the element's own computed `color` — a fact csscompute.ts
 *  knows and this module does not. */
export function colorOf(v: CssValue[]): Color | 'currentcolor' | undefined {
  const t = trimWs(v);
  if (t.length !== 1) return undefined;
  const x = t[0] as CssToken;

  if (x.kind === 'hash') return fromHex(x.value);

  if (x.kind === 'ident') {
    const name = x.value.toLowerCase();
    if (name === 'currentcolor') return 'currentcolor';
    if (name === 'transparent') return { rgb: [0, 0, 0], a: 0 };
    const named = NAMED_COLORS.get(name);
    return named === undefined ? undefined : { rgb: [named[0], named[1], named[2]], a: 1 };
  }

  if ((x as { kind: string }).kind !== 'function') return undefined;
  const fn = x as unknown as { name: string; args: CssValue[] };
  const name = fn.name.toLowerCase();
  const a = fnArgs(fn.args);
  if (a === undefined || a.length < 3 || a.length > 4) return undefined;

  const alphaArg = a[3];
  const alpha = alphaArg === undefined
    ? 1
    : clamp01(alphaArg.pct ? alphaArg.n / 100 : alphaArg.n);

  if (name === 'rgb' || name === 'rgba') {
    const comp = a.slice(0, 3).map((c) => clamp01(c.pct ? c.n / 100 : c.n / 255));
    return { rgb: [comp[0] as number, comp[1] as number, comp[2] as number], a: alpha };
  }

  if (name === 'hsl' || name === 'hsla') {
    const h = a[0] as FnArg;
    // The hue is a number or an angle, never a percentage.
    if (h.pct) return undefined;
    const s = a[1] as FnArg;
    const l = a[2] as FnArg;
    return { rgb: hslToRgb(h.n, s.n / 100, l.n / 100), a: alpha };
  }

  return undefined;
}
