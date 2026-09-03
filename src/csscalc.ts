/** CSS math functions — `calc()`, `min()`, `max()` and `clamp()` (CSS Values
 *  4 §10), over the component values cssparse.ts produces.
 *
 *  Invariant: a PURE LEAF. It imports cssparse.js and csstoken.js for TYPES
 *  and nothing else — no Document, no PDF object, no `node:` import, no
 *  htmldom.js, and NOT cssvalue.js, which imports this. It never re-reads a
 *  character: the tokenizer's output is the only input, the rule cssparse.ts,
 *  cssselect.ts and cssvalue.ts all hold.
 *
 *  Invariant: NEVER throws. An expression it cannot read is `undefined`, and
 *  the caller records it for zch2.7 rather than dropping it silently.
 *
 *  Invariant: it owns the DIMENSION TABLE. `lengthOf` used to hold it, and a
 *  copy here would be two answers to "how many px is 1pt" — but a length
 *  inside a math function and a length outside one must agree exactly, since
 *  `calc(1pt)` and `1pt` are the same value. cssvalue.ts calls `dimensionPx`;
 *  the edge runs one way and closes no cycle. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';

/** What a relative length resolves against. `fontSize` is the element's own
 *  computed font-size for every property EXCEPT `font-size` itself, where the
 *  caller passes the PARENT's — see csscompute.ts, which is the only place
 *  that distinction is made. */
export interface LengthContext {
  fontSize: number;
  rootFontSize: number;
}

/** A length-percentage expression.
 *
 *  `lin` is the LINEAR form, `A px + B %`, and it is what CSS Values 4 §10.9
 *  says every length-percentage math function reduces to. A `calc()` is a sum
 *  of products and so is always linear; a `min()`/`max()`/`clamp()` is linear
 *  only when no percentage reaches it, since which argument wins otherwise
 *  depends on the basis. The other three kinds exist for that one case, and
 *  are built ONLY when the fold cannot happen — so a document with no
 *  percentage-bearing comparison in it never sees anything but `lin`. */
export type CalcNode =
  | { kind: 'lin'; px: number; pct: number }
  | { kind: 'sum'; args: CalcNode[] }
  | { kind: 'scale'; k: number; arg: CalcNode }
  | { kind: 'fn'; fn: 'min' | 'max' | 'clamp'; args: CalcNode[] };

/** A math function's value. The two arms are the two TYPES: `calc(2 * 3)` is
 *  a number and `calc(2px * 3)` is a length-percentage, and no property takes
 *  both, which is what makes `width: calc(5)` refuse itself. */
export type MathValue = { num: number } | { lp: CalcNode };

const MATH_FNS = new Set(['calc', 'min', 'max', 'clamp']);

const lin = (px: number, pct: number): CalcNode => ({ kind: 'lin', px, pct });

// ---- the dimension table ---------------------------------------------------

/** px per unit, for the units whose ratio to px is fixed. 1in = 96px by
 *  definition and every other absolute unit follows from it. */
const ABSOLUTE: Record<string, number> = {
  px: 1,
  in: 96,
  pt: 96 / 72,
  pc: 96 / 6,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 2.54 / 40,
};

/** One dimension token in px, or undefined for a unit we refuse.
 *
 *  vw/vh and anything else: refused, not guessed. A viewport is the thing
 *  this stack deliberately does not have. */
export function dimensionPx(
  value: number, unit: string, ctx: LengthContext,
): number | undefined {
  const u = unit.toLowerCase();

  const abs = ABSOLUTE[u];
  if (abs !== undefined) return value * abs;

  if (u === 'em') return value * ctx.fontSize;
  if (u === 'rem') return value * ctx.rootFontSize;
  // CSS's documented fallback for both when font metrics are unavailable,
  // which they always are here. The oracle excludes ex and ch for exactly
  // this reason: Chrome has metrics, so agreement would be a coincidence.
  if (u === 'ex' || u === 'ch') return value * ctx.fontSize * 0.5;

  return undefined;
}

// ---- the node algebra ------------------------------------------------------

/** `k * node`, folded when the node is already linear. */
function scale(k: number, n: CalcNode): CalcNode {
  return n.kind === 'lin' ? lin(n.px * k, n.pct * k) : { kind: 'scale', k, arg: n };
}

function addNodes(a: CalcNode, b: CalcNode): CalcNode {
  if (a.kind === 'lin' && b.kind === 'lin') return lin(a.px + b.px, a.pct + b.pct);
  return { kind: 'sum', args: [a, b] };
}

/** Resolve an expression against a percentage BASIS. */
export function evalNode(n: CalcNode, basis: number): number {
  switch (n.kind) {
    case 'lin': return n.px + (n.pct * basis) / 100;
    case 'sum': return n.args.reduce((t, a) => t + evalNode(a, basis), 0);
    case 'scale': return n.k * evalNode(n.arg, basis);
    default: {
      const v = n.args.map((a) => evalNode(a, basis));
      if (n.fn === 'min') return Math.min(...v);
      if (n.fn === 'max') return Math.max(...v);
      // clamp(min, val, max), which is max(min, min(val, max)) — the lower
      // bound wins an inverted pair, as CSS Values 4 §10.5 specifies.
      return Math.max(v[0] as number, Math.min(v[1] as number, v[2] as number));
    }
  }
}

// ---- the grammar -----------------------------------------------------------

function isWs(v: CssValue | undefined): boolean {
  return v !== undefined && (v as CssToken).kind === 'whitespace';
}

function delimOf(v: CssValue | undefined): string | undefined {
  const t = v as CssToken | undefined;
  return t !== undefined && t.kind === 'delim' ? t.value : undefined;
}

/** A cursor whose position is SAVED and RESTORED rather than only advanced.
 *
 *  `parseProduct` has to look past whitespace for a `*`, and put the
 *  whitespace back when it finds a `+` instead — because `parseSum` needs to
 *  see that whitespace to know the `+` was spelled legally. */
class Cur {
  i = 0;
  constructor(private readonly v: CssValue[]) {}
  peek(): CssValue | undefined { return this.v[this.i]; }
  next(): CssValue | undefined { return this.v[this.i++]; }
  skipWs(): void { while (isWs(this.peek())) this.i++; }
  done(): boolean { this.skipWs(); return this.i >= this.v.length; }
}

function parseValue(c: Cur, ctx: LengthContext): MathValue | undefined {
  c.skipWs();
  const v = c.next();
  if (v === undefined) return undefined;

  if (v.kind === 'block') {
    if (v.open !== '(') return undefined;
    return parseWhole(v.contents, ctx);
  }
  if (v.kind === 'function') return mathValueOf(v, ctx);

  const t = v as CssToken;
  if (t.kind === 'number') return { num: t.value };
  if (t.kind === 'percentage') return { lp: lin(0, t.value) };
  if (t.kind === 'dimension') {
    const px = dimensionPx(t.value, t.unit, ctx);
    return px === undefined ? undefined : { lp: lin(px, 0) };
  }
  return undefined;
}

/** `*` needs a NUMBER on one side and `/` a number on the RIGHT. An area is
 *  not a type any property here takes, and CSS Values 4 admits neither. */
function parseProduct(c: Cur, ctx: LengthContext): MathValue | undefined {
  let left = parseValue(c, ctx);
  if (left === undefined) return undefined;

  for (;;) {
    const save = c.i;
    c.skipWs();
    const op = delimOf(c.peek());
    if (op !== '*' && op !== '/') { c.i = save; return left; }
    c.next();

    const right = parseValue(c, ctx);
    if (right === undefined) return undefined;

    if (op === '*') {
      if ('num' in left && 'num' in right) { left = { num: left.num * right.num }; continue; }
      if ('num' in left && 'lp' in right) { left = { lp: scale(left.num, right.lp) }; continue; }
      if ('lp' in left && 'num' in right) { left = { lp: scale(right.num, left.lp) }; continue; }
      return undefined;
    }

    // A divisor is number-typed, and a number-typed subtree can hold no
    // percentage — every rule above refuses one — so it is fully known here
    // and a zero divisor is decided at PARSE time rather than becoming a
    // resolve-time surprise on some containing blocks and not others.
    //
    // A DELIBERATE DIVERGENCE, and the oracle is what found it. CSS Values 3
    // made division by zero invalid; Values 4 §10.9 made it produce ±infinity
    // and then clamps at §10.12's range-checking step, and Chrome follows
    // Values 4 — measured, `margin-top: calc(10px / 0)` computes to
    // 33554432px (2^25) in Chrome/152. We refuse instead, and it is not
    // pedantry about spec era: this library's consumer is a PDF renderer, so
    // an infinite length reaches stamp.ts, which throws on a non-finite rect.
    // Matching Chrome would mean adopting §10.12's clamp as well, for an
    // expression no document means. A refused declaration falls back to the
    // initial or inherited value, which renders; 33 million pixels does not.
    // test/fixtures/css-cascade/PROVENANCE.md records this, and the case is
    // out of the corpus rather than allowlisted inside it — that corpus runs
    // WHOLE, which is a property worth more than one extra fixture.
    if (!('num' in right) || right.num === 0) return undefined;
    left = 'num' in left
      ? { num: left.num / right.num }
      : { lp: scale(1 / right.num, left.lp) };
  }
}

/** `+` and `-` demand MATCHING types and whitespace on BOTH sides.
 *
 *  CSS requires that whitespace, and it is worth recording that FOUR
 *  different mechanisms enforce it, because the obvious single explanation is
 *  wrong for two of the four spellings:
 *
 *    calc(1px-2px)    ONE dimension whose unit is `px-2px` — `-` is a name
 *                     character, so the tokenizer never sees an operator at
 *                     all and `dimensionPx` refuses the unit.
 *    calc(1px -2px)   two dimensions, `-2px` having absorbed its sign; no
 *                     operator, so `parseWhole` refuses the unconsumed tail.
 *    calc(1px+ 2px)   a real delim, refused by the `spaced` check below.
 *    calc(1px +(2px)) a real delim, refused by the whitespace-AFTER check —
 *                     the ONLY input that check catches, since every other
 *                     unspaced spelling is already gone by then.
 *
 *  Each is pinned by its own case in test/csscalc.test.ts for that reason: a
 *  single fixture would leave three of the four mechanisms unmeasured. */
function parseSum(c: Cur, ctx: LengthContext): MathValue | undefined {
  let left = parseProduct(c, ctx);
  if (left === undefined) return undefined;

  for (;;) {
    const save = c.i;
    const spaced = isWs(c.peek());
    c.skipWs();
    const op = delimOf(c.peek());
    if (op !== '+' && op !== '-') { c.i = save; return left; }
    if (!spaced) return undefined;
    c.next();
    if (!isWs(c.peek())) return undefined;

    const right = parseProduct(c, ctx);
    if (right === undefined) return undefined;

    if ('num' in left && 'num' in right) {
      left = { num: op === '+' ? left.num + right.num : left.num - right.num };
      continue;
    }
    if ('lp' in left && 'lp' in right) {
      left = { lp: addNodes(left.lp, op === '+' ? right.lp : scale(-1, right.lp)) };
      continue;
    }
    return undefined;
  }
}

/** A whole expression, which must consume every value it was given. */
function parseWhole(v: CssValue[], ctx: LengthContext): MathValue | undefined {
  const c = new Cur(v);
  const r = parseSum(c, ctx);
  return r === undefined || !c.done() ? undefined : r;
}

/** Split on the TOP-LEVEL commas. A comma inside a nested function rides
 *  along in that function's own component value, so a flat scan is right. */
function commaParts(v: CssValue[]): CssValue[][] {
  const out: CssValue[][] = [[]];
  for (const x of v) {
    if ((x as CssToken).kind === 'comma') { out.push([]); continue; }
    (out[out.length - 1] as CssValue[]).push(x);
  }
  return out;
}

/** min()/max()/clamp(): every argument shares one type, and the fold to a
 *  plain number happens whenever no percentage reaches the comparison. */
function comparison(
  fn: 'min' | 'max' | 'clamp', args: CssValue[], ctx: LengthContext,
): MathValue | undefined {
  const parts = commaParts(args);
  if (fn === 'clamp' ? parts.length !== 3 : parts.length < 1) return undefined;

  const vals: MathValue[] = [];
  for (const p of parts) {
    const r = parseWhole(p, ctx);
    if (r === undefined) return undefined;
    vals.push(r);
  }

  const nums = vals.filter((v): v is { num: number } => 'num' in v);
  if (nums.length === vals.length) {
    const n = nums.map((v) => v.num);
    return { num: evalNode({ kind: 'fn', fn, args: n.map((x) => lin(x, 0)) }, 0) };
  }
  if (nums.length !== 0) return undefined;      // a mixed argument list

  const nodes = vals.map((v) => (v as { lp: CalcNode }).lp);
  // With no percentage anywhere the comparison does not depend on the basis,
  // so it folds now and this function's tree never reaches a caller.
  if (nodes.every((n) => n.kind === 'lin' && n.pct === 0)) {
    return { lp: lin(evalNode({ kind: 'fn', fn, args: nodes }, 0), 0) };
  }
  return { lp: { kind: 'fn', fn, args: nodes } };
}

/** Read one component value as a math function. Undefined for anything that
 *  is not a `calc()`, `min()`, `max()` or `clamp()`, so a caller can offer it
 *  every value and branch on the answer. */
export function mathValueOf(v: CssValue, ctx: LengthContext): MathValue | undefined {
  // `args` narrows away csstoken.ts's own `function` token, which carries a
  // name and nothing else. cssparse.ts never emits one — it turns every such
  // token into the block-bearing form — so this is narrowing rather than a
  // case that can occur.
  if (v.kind !== 'function' || !('args' in v)) return undefined;
  const name = v.name.toLowerCase();
  if (!MATH_FNS.has(name)) return undefined;
  if (name === 'calc') return parseWhole(v.args, ctx);
  return comparison(name as 'min' | 'max' | 'clamp', v.args, ctx);
}
