/** CSS selectors: parsing, matching and specificity (Selectors Level 4).
 *
 *  Invariant: a PURE LEAF. It imports htmldom.js for types and
 *  cssparse.js/csstoken.js for values. No Document, no PDF object, no `node:`
 *  import, and no svgcss.js. Collecting <style> text is a tree walk and stays
 *  zch2.2.3's, as zch2.2.1 already decided for the syntax modules.
 *
 *  Invariant: NEVER throws. An unsupported or malformed selector is a `null`
 *  return and the caller drops the rule — which is CSS's own behaviour for an
 *  invalid selector, not a degradation we invented. This is csstoken.ts's and
 *  htmltoken.ts's rule and the opposite of parseXml.
 *
 *  Invariant, and the reason this sits BESIDE svgcss.ts rather than replacing
 *  it: that module takes a raw STRING and finds selectors with regexes,
 *  because it predates any CSS tokenizer here; it walks XmlNode, which has no
 *  parent pointers, so its matcher threads an explicit ancestors array; and
 *  SVG is case-sensitive XML where HTML is not. Six SVG modules and a
 *  browser-rendered golden set depend on it. Two grammars sharing a name and
 *  no code — the idiom tablegrid.ts/tablespan.ts and mdscan.ts/htmltoken.ts
 *  already set. */

import { parseComponentValueList } from './cssparse.js';
import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';
import { langMatches, nodeDirection, nodeLanguage } from './htmllang.js';

export type Combinator = 'descendant' | 'child' | 'next-sibling' | 'subsequent-sibling';

export type AttrOp = 'exists' | '=' | '~=' | '|=' | '^=' | '$=' | '*=';

export interface AttrSel {
  name: string;
  op: AttrOp;
  value?: string;
  /** The `i` flag. Absent means case-sensitive, `false` is an explicit `s`. */
  ci?: boolean;
}

/** Widened by later work: the logical kinds. `never` is a RECOGNISED
 *  pseudo-class with no static answer, which is not the same as unsupported. */
export type Pseudo =
  | { kind: 'never' }
  | { kind: 'link' }
  | { kind: 'root' | 'empty' }
  | { kind: 'only'; axis: 'child' | 'of-type' }
  | { kind: 'nth'; axis: 'child' | 'of-type'; fromEnd: boolean; a: number; b: number }
  | { kind: 'not' | 'is' | 'where'; args: SelectorList }
  // The anchor a relative selector hangs off, and the ONE kind no author can
  // write: `:scope` is not accepted by parsePseudo, so this is reachable only
  // as parts[0] of a :has() argument. That is what lets it weigh [0, 0, 0]
  // honestly — Selectors 4 counts a :has() as its most specific ARGUMENT, and
  // the implicit anchor is not part of what the author wrote.
  | { kind: 'scope' }
  // Each argument is an ordinary ComplexSelector whose parts[0] is the scope
  // compound and whose combinators[0] is the relative selector's lead, so the
  // existing right-to-left matchFrom does the anchoring — backtracking
  // included — and this module gains no second matching algorithm.
  | { kind: 'has'; args: SelectorList }
  // Both answer from the DOM rather than the cascade: `lang` and `dir` are
  // HTML ATTRIBUTES, inherited through parent pointers, and ComputedStyle
  // carries neither. See htmllang.ts.
  | { kind: 'lang'; ranges: string[] }
  // The value is kept as written rather than narrowed to 'ltr' | 'rtl':
  // Selectors 4 makes an UNKNOWN directionality valid-and-never-matching, so
  // it must survive parsing to be compared and fail.
  | { kind: 'dir'; value: string };

/** One compound selector: everything that must match the SAME element.
 *
 *  `id` and `classes` are kept out of `attrs` even though both are attributes
 *  underneath. Matching is then a direct compare rather than a scan, and
 *  specificity reads off the shape instead of re-deriving which attribute
 *  selectors were really classes. */
export interface Compound {
  /** ASCII-lowercased, once, at parse time.
   *
   *  ONE spelling is enough because our tree always comes from `parseHtml`,
   *  and in an HTML document a type selector folds against EVERY element —
   *  see matchCompound, where the obvious reading is recorded as wrong. */
  type?: string;
  /** Every id in this compound, in source order.
   *
   *  A LIST rather than a single field, mirroring `classes`, because `#a#b`
   *  is valid CSS: the grammar admits it and it simply matches nothing.
   *  Rejecting a second id turns a never-matching selector into an INVALID
   *  one, and an invalid selector invalidates the whole list — so `p, #a#b`
   *  would lose its `p` half and the document render unstyled. Specificity
   *  counts each of them, which a single field could not. */
  ids: string[];
  classes: string[];
  attrs: AttrSel[];
  pseudos: Pseudo[];
  pseudoElement?: string;
}

export interface ComplexSelector {
  /** Leftmost first. Matching runs right-to-left over this. */
  parts: Compound[];
  /** combinators[i] joins parts[i] to parts[i + 1]. */
  combinators: Combinator[];
}

export type SelectorList = ComplexSelector[];

// ---- small helpers over the component-value stream -------------------------

function isWs(v: CssValue | undefined): boolean {
  return v !== undefined && (v as CssToken).kind === 'whitespace';
}

function isDelim(v: CssValue | undefined, ch: string): boolean {
  const t = v as CssToken | undefined;
  return t !== undefined && t.kind === 'delim' && t.value === ch;
}

/** An ident or a string, which is what an attribute value may be. */
function textValue(v: CssValue | undefined): string | undefined {
  const t = v as CssToken | undefined;
  if (t === undefined) return undefined;
  if (t.kind === 'ident' || t.kind === 'string') return t.value;
  return undefined;
}

const ATTR_OPS = new Set(['~=', '|=', '^=', '$=', '*=']);

// ---- attribute selectors ---------------------------------------------------

/** Parse the contents of a `[...]` block.
 *
 *  Note `=` arrives as a DELIM while the five compound operators arrive as
 *  `match` tokens — csstoken.ts emits those as single tokens at the spec era
 *  it is pinned to, which is what spares this module rejoining two delims.
 *  A parser keyed on `kind === 'match'` alone silently rejects `[a=b]`. */
function parseAttr(contents: CssValue[]): AttrSel | null {
  const v = contents.filter((x) => !isWs(x));
  const nameTok = v[0] as CssToken | undefined;
  if (nameTok === undefined || nameTok.kind !== 'ident') return null;
  // An attribute NAME is ASCII case-insensitive on an HTML element; folding
  // here means the matcher compares two folded strings.
  const name = nameTok.value.toLowerCase();
  if (v.length === 1) return { name, op: 'exists' };

  const opTok = v[1] as CssToken;
  let op: AttrOp;
  if (opTok.kind === 'delim' && opTok.value === '=') op = '=';
  else if (opTok.kind === 'match' && ATTR_OPS.has(opTok.value)) op = opTok.value as AttrOp;
  else return null;

  const value = textValue(v[2]);
  if (value === undefined) return null;
  if (v.length === 3) return { name, op, value };
  if (v.length !== 4) return null;

  const flag = textValue(v[3])?.toLowerCase();
  if (flag === 'i') return { name, op, value, ci: true };
  if (flag === 's') return { name, op, value, ci: false };
  return null;
}

// ---- the An+B microsyntax --------------------------------------------------

/** CSS Syntax's An+B microsyntax, over the component values inside an
 *  `:nth-*()` function.
 *
 *  Four of its forms are a SINGLE token because `n-1` is a valid CSS name, so
 *  `2n-1` is a dimension whose UNIT is `n-1` rather than a dimension followed
 *  by a number, and `n-1` is one ident. A parser written from the obvious
 *  reading handles `2n+1` and silently mis-handles `2n-1` — which is `odd`
 *  shifted by one, so a striped table still looks striped and only the first
 *  row is wrong. The spec names these <ndashdigit-dimension> and
 *  <ndashdigit-ident>. */
const NDASHDIGIT = /^n-(\d+)$/;

function parseAnB(args: CssValue[]): { a: number; b: number } | null {
  const v = args.filter((x) => !isWs(x));
  if (v.length === 0) return null;

  const first = v[0] as CssToken;

  // `odd` / `even` / `n` / `-n` / `n-1` / `-n-1`
  if (first.kind === 'ident') {
    const id = first.value.toLowerCase();
    if (id === 'odd' && v.length === 1) return { a: 2, b: 1 };
    if (id === 'even' && v.length === 1) return { a: 2, b: 0 };

    const neg = id.startsWith('-');
    const body = neg ? id.slice(1) : id;
    const a = neg ? -1 : 1;

    if (body === 'n') return tail(v, 1, a);
    const m = NDASHDIGIT.exec(body);
    // <ndashdigit-ident>: the whole B is inside the ident, so nothing may
    // follow it. `n-1-2` must be rejected, not read as `n-1`.
    if (m !== null && v.length === 1) return { a, b: -Number(m[1]) };
    // `n-` followed by a signless integer: `n- 1`.
    if (body === 'n-') {
      const num = v[1] as CssToken | undefined;
      if (v.length === 2 && num !== undefined && num.kind === 'number' && num.int
        && !/^[+-]/.test(num.repr)) return { a, b: -num.value };
    }
    return null;
  }

  // `2n`, `2n+1`, `2n-1` (unit `n-1`)
  if (first.kind === 'dimension') {
    if (!first.int) return null;
    const unit = first.unit.toLowerCase();
    if (unit === 'n') return tail(v, 1, first.value);
    const m = NDASHDIGIT.exec(unit);
    if (m !== null && v.length === 1) return { a: first.value, b: -Number(m[1]) };
    return null;
  }

  // A bare integer: `3`, `+3`, `-3`.
  if (first.kind === 'number' && first.int && v.length === 1) {
    return { a: 0, b: first.value };
  }

  return null;
}

/** The B half following an `n` term: nothing, a signed number, or an explicit
 *  sign delim then a SIGNLESS number. `n +1` is invalid — a signed number
 *  after whitespace is fine (`n -1`), but `+ 1` must be a delim then a
 *  signless integer, which is why the two shapes are checked separately. */
function tail(v: CssValue[], at: number, a: number): { a: number; b: number } | null {
  if (v.length === at) return { a, b: 0 };

  const t = v[at] as CssToken;
  if (t.kind === 'number' && t.int && v.length === at + 1) {
    // Must carry its own sign: `n 1` is invalid, `n +1` and `n -1` are not.
    if (!/^[+-]/.test(t.repr)) return null;
    return { a, b: t.value };
  }
  if (t.kind === 'delim' && (t.value === '+' || t.value === '-') && v.length === at + 2) {
    const num = v[at + 1] as CssToken;
    if (num.kind !== 'number' || !num.int || /^[+-]/.test(num.repr)) return null;
    return { a, b: t.value === '+' ? num.value : -num.value };
  }
  return null;
}

/** Does `index` (1-based) satisfy An+B? Solve index = a*k + b for an integer
 *  k >= 0. With a === 0 the only match is index === b. */
function nthMatches(a: number, b: number, index: number): boolean {
  if (a === 0) return index === b;
  const k = (index - b) / a;
  return Number.isInteger(k) && k >= 0;
}

// ---- pseudo-classes and pseudo-elements ------------------------------------

const PLAIN_NTH: Record<string, { axis: 'child' | 'of-type'; fromEnd: boolean }> = {
  'first-child': { axis: 'child', fromEnd: false },
  'last-child': { axis: 'child', fromEnd: true },
  'first-of-type': { axis: 'of-type', fromEnd: false },
  'last-of-type': { axis: 'of-type', fromEnd: true },
};

const ONLY: Record<string, 'child' | 'of-type'> = {
  'only-child': 'child',
  'only-of-type': 'of-type',
};

const NTH_FN: Record<string, { axis: 'child' | 'of-type'; fromEnd: boolean }> = {
  'nth-child': { axis: 'child', fromEnd: false },
  'nth-last-child': { axis: 'child', fromEnd: true },
  'nth-of-type': { axis: 'of-type', fromEnd: false },
  'nth-last-of-type': { axis: 'of-type', fromEnd: true },
};

/** No static answer in a printed document. :visited never matches, which is
 *  both correct here and what browsers do for privacy. */
const DYNAMIC = new Set([
  'hover', 'active', 'focus', 'focus-visible', 'focus-within', 'target', 'visited',
]);

/** An <a>, <area> or <link> carrying an href. */
const LINK_TYPES = new Set(['a', 'area', 'link']);

interface ParsedPseudo {
  pseudo?: Pseudo;
  pseudoElement?: string;
  next: number;
}

/** `:lang()`'s argument: ONE unquoted language range. Null for anything else,
 *  which invalidates the whole selector list as every refusal here does.
 *
 *  **Narrower than Selectors 4 on purpose, and it was measured.** The spec
 *  writes `<language-range>#` — a comma-separated list whose members may be
 *  strings and may carry `*` wildcards — but Chrome 152 refuses every one of
 *  those forms, `:lang("en")` included, and accepts only a bare ident.
 *  Implementing the wider grammar would make us ACCEPT selectors every
 *  shipping browser discards, and by this module's own rule an unsupported
 *  selector invalidates its whole list — so `p, p:lang("*-CH")` would style
 *  content here that no browser styles, in the permissive direction, and the
 *  Blink corpus could not see the divergence because Blink refuses the
 *  selector rather than answering it.
 *
 *  The RFC 4647 extended-filtering MATCHER is unaffected and still wildcard-
 *  capable (see `langMatches`): what narrows is the syntax an author may
 *  write, not the rule by which a tag is compared. */
function parseLangRanges(args: CssValue[]): string[] | null {
  const ws = args.filter((a) => (a as CssToken).kind !== 'whitespace');
  if (ws.length !== 1) return null;
  const t = ws[0] as CssToken;
  if (t.kind !== 'ident' || t.value.trim() === '') return null;
  return [t.value.trim()];
}

/** `v[at]` is a colon. A SECOND colon means a pseudo-element.
 *
 *  `inHas` says we are already inside a `:has()` argument, where both a
 *  nested `:has()` and a pseudo-element are invalid — Blink's behaviour, and
 *  what stops `:has()` from acquiring an unbounded nesting cost. It rides
 *  through `:is()`/`:not()`/`:where()` too, so `:has(:is(p:has(x)))` is
 *  refused by the same rule rather than by a second one. */
function parsePseudo(v: CssValue[], at: number, inHas: boolean): ParsedPseudo | null {
  let i = at + 1;
  let isElement = false;
  if ((v[i] as CssToken | undefined)?.kind === 'colon') { isElement = true; i++; }

  const t = v[i] as CssToken | undefined;
  if (t === undefined) return null;

  if (isElement) {
    // Parsed and RECORDED so zch2.3/zch2.4 can pick up generated content
    // without re-parsing, and so a ::before rule does not invalidate a list
    // it shares. It matches no real element — see matchCompound.
    if (t.kind !== 'ident') return null;
    if (inHas) return null;                 // no pseudo-element in a :has()
    return { pseudoElement: t.value.toLowerCase(), next: i + 1 };
  }

  if (t.kind === 'ident') {
    const name = t.value.toLowerCase();
    if (name === 'root' || name === 'empty') return { pseudo: { kind: name }, next: i + 1 };
    const only = ONLY[name];
    if (only !== undefined) return { pseudo: { kind: 'only', axis: only }, next: i + 1 };
    const plain = PLAIN_NTH[name];
    if (plain !== undefined) {
      return { pseudo: { kind: 'nth', ...plain, a: 0, b: 1 }, next: i + 1 };
    }
    // RECOGNISED and never matching, which is NOT the same as unsupported.
    // An unsupported selector invalidates the whole list, so treating :hover
    // as unknown makes `a, a:hover { color: blue }` drop its `a` half too and
    // the document render unstyled rather than merely un-hovered.
    if (DYNAMIC.has(name)) return { pseudo: { kind: 'never' }, next: i + 1 };
    // :link is the exception in that group and DOES match: an <a> with an
    // href is a fact about the document rather than about a pointer.
    if (name === 'link') return { pseudo: { kind: 'link' }, next: i + 1 };
    return null;
  }

  if ((t as { kind: string }).kind === 'function') {
    const fn = t as unknown as { name: string; args: CssValue[] };
    const nth = NTH_FN[fn.name.toLowerCase()];
    if (nth !== undefined) {
      const ab = parseAnB(fn.args);
      if (ab === null) return null;
      return { pseudo: { kind: 'nth', ...nth, a: ab.a, b: ab.b }, next: i + 1 };
    }
    const logical = fn.name.toLowerCase();
    if (logical === 'not' || logical === 'is' || logical === 'where') {
      // NON-forgiving for all three here: an unparseable argument makes the
      // whole selector unsupported, so the caller drops the rule rather than
      // applying a narrower version of what the author wrote.
      const args = parseSelectorList(fn.args, inHas);
      if (args === null) return null;
      return { pseudo: { kind: logical, args }, next: i + 1 };
    }
    if (logical === 'has') {
      // Non-forgiving too, which is the CURRENT reading: Selectors 4 made
      // :has() take a plain <relative-selector-list> after the forgiving one
      // broke feature detection, and Blink follows.
      if (inHas) return null;               // no :has() inside a :has()
      const args = parseRelativeSelectorList(fn.args);
      if (args === null) return null;
      return { pseudo: { kind: 'has', args }, next: i + 1 };
    }
    if (logical === 'lang') {
      const ranges = parseLangRanges(fn.args);
      if (ranges === null) return null;
      return { pseudo: { kind: 'lang', ranges }, next: i + 1 };
    }
    if (logical === 'dir') {
      const ws = fn.args.filter((a) => (a as CssToken).kind !== 'whitespace');
      const only = ws.length === 1 ? (ws[0] as CssToken) : undefined;
      // An EMPTY argument is invalid, where an unknown VALUE is not: the
      // first is a selector the author did not finish writing, the second is
      // a direction we do not know, which Selectors 4 says matches nothing.
      if (only === undefined || only.kind !== 'ident') return null;
      return { pseudo: { kind: 'dir', value: only.value.toLowerCase() }, next: i + 1 };
    }
    return null;
  }

  return null;
}

// ---- compound selectors ----------------------------------------------------

function emptyCompound(): Compound {
  return { ids: [], classes: [], attrs: [], pseudos: [] };
}

/** Consume one compound selector starting at `i`. Returns the compound and
 *  the index after it, or null when the syntax is one we do not implement.
 *
 *  `used` reports whether anything at all was consumed, which is how a caller
 *  tells `*` (a real compound constraining nothing) from an empty run. */
function parseCompound(
  v: CssValue[], start: number, inHas: boolean,
): { compound: Compound; next: number } | null {
  const c = emptyCompound();
  let i = start;
  let used = false;

  for (; i < v.length; i++) {
    const t = v[i] as CssToken;
    if (t.kind === 'ident') {
      if (used) return null;                 // a type must lead its compound
      // A namespace prefix (`svg|rect`) has nothing to resolve against: we
      // implement no @namespace. Reject rather than silently drop the prefix.
      if (isDelim(v[i + 1], '|')) return null;
      c.type = t.value.toLowerCase();
      used = true;
      continue;
    }
    if (t.kind === 'hash') {
      // `#1a` is a hash whose name is not an identifier. It is not an id
      // selector, and accepting it admits a selector CSS does not have.
      if (t.id !== true) return null;
      c.ids.push(t.value);
      used = true;
      continue;
    }
    if (t.kind === 'delim' && t.value === '.') {
      const name = v[i + 1] as CssToken | undefined;
      if (name === undefined || name.kind !== 'ident') return null;
      c.classes.push(name.value);
      i++;
      used = true;
      continue;
    }
    if (t.kind === 'delim' && t.value === '*') {
      if (used) return null;
      if (isDelim(v[i + 1], '|')) return null;
      used = true;                           // constrains nothing, but IS a compound
      continue;
    }
    if ((t as { kind: string }).kind === 'block'
      && (t as unknown as { open: string }).open === '[') {
      const a = parseAttr((t as unknown as { contents: CssValue[] }).contents);
      if (a === null) return null;
      c.attrs.push(a);
      used = true;
      continue;
    }
    if (t.kind === 'colon') {
      const parsed = parsePseudo(v, i, inHas);
      if (parsed === null) return null;
      if (parsed.pseudoElement !== undefined) {
        if (c.pseudoElement !== undefined) return null;   // only one may follow
        c.pseudoElement = parsed.pseudoElement;
      } else {
        c.pseudos.push(parsed.pseudo as Pseudo);
      }
      i = parsed.next - 1;                                // the loop's i++ re-adds one
      used = true;
      continue;
    }
    break;                                    // whitespace, a combinator, or a comma
  }

  if (!used) return null;
  return { compound: c, next: i };
}

// ---- complex selectors -----------------------------------------------------

/** Parse one complex selector from a comma-delimited run. */
function parseComplex(v: CssValue[], inHas: boolean): ComplexSelector | null {
  const parts: Compound[] = [];
  const combinators: Combinator[] = [];
  let i = 0;
  let pending: Combinator | null = null;

  for (;;) {
    while (isWs(v[i])) i++;
    if (i >= v.length) break;

    const t = v[i] as CssToken;
    if (t.kind === 'delim' && (t.value === '>' || t.value === '+' || t.value === '~')) {
      if (parts.length === 0 || pending !== null) return null;   // leading or doubled
      pending = t.value === '>' ? 'child'
        : t.value === '+' ? 'next-sibling' : 'subsequent-sibling';
      i++;
      continue;
    }

    const got = parseCompound(v, i, inHas);
    if (got === null) return null;
    if (parts.length > 0) {
      // Whitespace before this compound with no explicit combinator IS the
      // descendant combinator.
      combinators.push(pending ?? 'descendant');
    }
    pending = null;
    parts.push(got.compound);
    i = got.next;
  }

  if (parts.length === 0) return null;
  if (pending !== null) return null;          // trailing combinator
  return { parts, combinators };
}

/** Split a prelude on top-level commas. The parser never sees a comma inside
 *  a block or a function, because cssparse.ts has already nested those. */
function splitList(prelude: CssValue[]): CssValue[][] {
  const out: CssValue[][] = [];
  let run: CssValue[] = [];
  for (const v of prelude) {
    if ((v as CssToken).kind === 'comma') { out.push(run); run = []; continue; }
    run.push(v);
  }
  out.push(run);
  return out;
}

/** Parse a qualified rule's prelude into a selector list, or null when any
 *  part of it is unsupported.
 *
 *  ONE invalid selector invalidates the WHOLE list — CSS's own rule, and the
 *  reason it matters is that the surviving half of a partly-applied rule is
 *  indistinguishable from a correct render. */
export function parseSelectorList(
  prelude: CssValue[], inHas = false,
): SelectorList | null {
  const out: SelectorList = [];
  for (const run of splitList(prelude)) {
    const sel = parseComplex(run, inHas);
    if (sel === null) return null;
    out.push(sel);
  }
  return out.length === 0 ? null : out;
}

/** Convenience for tests and the oracle harness: tokenize, then parse. */
export function parseSelectorText(src: string): SelectorList | null {
  return parseSelectorList(parseComponentValueList(src));
}

// ---- relative selectors, which only :has() takes ---------------------------

/** The compound standing for `:has()`'s implicit anchor. Built fresh each
 *  time rather than shared, so nothing can mutate one argument's anchor
 *  through another's. */
function scopeCompound(): Compound {
  return { ids: [], classes: [], attrs: [], pseudos: [{ kind: 'scope' }] };
}

const LEADS: Record<string, Combinator> = {
  '>': 'child', '+': 'next-sibling', '~': 'subsequent-sibling',
};

/** One relative selector: an optional leading combinator, then an ordinary
 *  complex selector.
 *
 *  The result is an ordinary ComplexSelector with the anchor PREPENDED, which
 *  is the whole trick — `:has(> div p)` becomes `:scope > div p`, and
 *  matchFrom's existing right-to-left walk then does the anchoring for free.
 *  Written any other way, "some descendant matches `div p`" is the plausible
 *  reading, and it is wrong: it reports every div with a p anywhere below it
 *  rather than one whose OWN child div holds the p. */
function parseRelative(v: CssValue[]): ComplexSelector | null {
  let i = 0;
  while (isWs(v[i])) i++;
  const t = v[i] as CssToken | undefined;

  // No leading combinator means the descendant one, which is why a bare
  // `:has(p)` asks about the subtree rather than about the element itself.
  let lead: Combinator = 'descendant';
  if (t !== undefined && t.kind === 'delim' && LEADS[t.value] !== undefined) {
    lead = LEADS[t.value] as Combinator;
    i++;
  }

  const sel = parseComplex(v.slice(i), true);
  if (sel === null) return null;            // empty, or a bare combinator
  return {
    parts: [scopeCompound(), ...sel.parts],
    combinators: [lead, ...sel.combinators],
  };
}

function parseRelativeSelectorList(args: CssValue[]): SelectorList | null {
  const out: SelectorList = [];
  for (const run of splitList(args)) {
    const sel = parseRelative(run);
    if (sel === null) return null;
    out.push(sel);
  }
  return out.length === 0 ? null : out;
}

// ---- tree access -----------------------------------------------------------

/** The document a node belongs to, or null. A template's content fragment has
 *  a null parent (htmltree.ts assigns createFragment(), which does not point
 *  back), so an element inside one has no owner document — which is exactly
 *  right: CSS must not reach into template content, and here that falls out
 *  of the shape rather than needing a rule. */
function ownerDocument(el: HtmlElement): HtmlDocument | null {
  let n: HtmlNode | null = el;
  while (n !== null && n.kind !== 'document') n = n.parent;
  return n === null ? null : n;
}

function parentElement(el: HtmlElement): HtmlElement | null {
  const p = el.parent;
  return p !== null && p.kind === 'element' ? p : null;
}

/** The element children of a node, in document order. */
function elementChildren(n: HtmlNode): HtmlElement[] {
  if (n.kind !== 'element' && n.kind !== 'document' && n.kind !== 'fragment') return [];
  return n.children.filter((c): c is HtmlElement => c.kind === 'element');
}

/** Every preceding sibling ELEMENT, nearest first. Text and comments are
 *  skipped: `h1 + p` must match across the whitespace between the two. */
function precedingSiblings(el: HtmlElement): HtmlElement[] {
  const p = el.parent;
  if (p === null) return [];
  const sibs = elementChildren(p);
  const at = sibs.indexOf(el);
  return at <= 0 ? [] : sibs.slice(0, at).reverse();
}

// ---- attribute reads -------------------------------------------------------

/** Attribute NAMES are ASCII case-insensitive on an HTML element and exact on
 *  a foreign one. The parser has already lowercased the selector's name, so
 *  an HTML lookup is a direct get; a foreign element needs a scan, since its
 *  stored key may carry case the lowercased selector name cannot address. */
function attrOf(el: HtmlElement, name: string): string | undefined {
  const direct = el.attrs.get(name);
  if (direct !== undefined) return direct;
  if (el.ns === 'html') return undefined;
  for (const [k, v] of el.attrs) if (k.toLowerCase() === name) return v;
  return undefined;
}

function eqCase(a: string, b: string, ci: boolean): boolean {
  return ci ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function matchAttr(a: AttrSel, el: HtmlElement): boolean {
  const have = attrOf(el, a.name);
  if (have === undefined) return false;
  if (a.op === 'exists') return true;
  const want = a.value ?? '';
  const ci = a.ci === true;
  switch (a.op) {
    case '=': return eqCase(have, want, ci);
    // A whitespace-separated WORD, not a substring: [class~="tw"] must not
    // match class="one two".
    case '~=':
      if (want === '' || /\s/.test(want)) return false;
      return have.split(/\s+/).some((w) => eqCase(w, want, ci));
    // The exact value, or the value followed by a hyphen — the language-range
    // operator, so [lang|="en"] matches "en-GB" and [lang|="en-G"] does not.
    case '|=':
      return eqCase(have, want, ci)
        || (have.length > want.length
          && have[want.length] === '-'
          && eqCase(have.slice(0, want.length), want, ci));
    // Selectors 4: these three never match an empty value. Without the guard
    // [href^=""] matches every element that HAS an href, which reads as a
    // working selector.
    case '^=':
      return want !== '' && eqCase(have.slice(0, want.length), want, ci);
    case '$=':
      return want !== '' && have.length >= want.length
        && eqCase(have.slice(have.length - want.length), want, ci);
    case '*=':
      return want !== ''
        && (ci ? have.toLowerCase().includes(want.toLowerCase()) : have.includes(want));
    default: return false;
  }
}

// ---- compound matching -----------------------------------------------------

function classList(el: HtmlElement): string[] {
  const c = attrOf(el, 'class');
  return c === undefined ? [] : c.trim().split(/\s+/).filter((x) => x !== '');
}

/** Quirks mode makes `#id` and `.class` match ASCII case-insensitively — a
 *  legacy behaviour every browser implements. `HtmlDocument.quirks` is
 *  computed by htmltree.ts from §13.2.6.4.1 and, before this module, read by
 *  exactly one line of parsing logic. */
function quirksOf(el: HtmlElement): boolean {
  return ownerDocument(el)?.quirks === true;
}

function matchCompound(c: Compound, el: HtmlElement, scope: HtmlElement | null): boolean {
  // A type name is ASCII case-insensitive against EVERY element, foreign ones
  // included, because the document is an HTML document — which is the whole
  // input to this module, `parseHtml` being the only producer of the tree.
  //
  // The obvious reading is that folding is for HTML elements and a foreign
  // one is compared exactly, so `lineargradient` would not match SVG
  // <linearGradient>. This issue's own design and plan both said so, and it
  // is WRONG for an HTML document: Blink matches `linearGradient`,
  // `lineargradient` and `LINEARGRADIENT` alike, through querySelectorAll,
  // Element.matches and the stylesheet cascade — while `clippath` still
  // fails to match, so it really is folding rather than a wildcard. The
  // case-sensitive rule is XML's, and was confirmed against a document
  // parsed as application/xml, where `lineargradient` matches nothing.
  //
  // The parser folds once, so this compares two already-folded strings.
  if (c.type !== undefined && c.type !== el.name.toLowerCase()) return false;

  const ci = quirksOf(el);
  if (c.ids.length > 0) {
    const have = attrOf(el, 'id');
    if (have === undefined) return false;
    // EVERY id must match, so a compound naming two matches nothing at all.
    for (const want of c.ids) if (!eqCase(have, want, ci)) return false;
  }
  if (c.classes.length > 0) {
    const have = classList(el);
    for (const want of c.classes) {
      if (!have.some((h) => eqCase(h, want, ci))) return false;
    }
  }
  for (const a of c.attrs) if (!matchAttr(a, el)) return false;
  for (const p of c.pseudos) if (!matchPseudo(p, el, scope)) return false;
  // A pseudo-element selects a pseudo-element, which is not in the tree. The
  // selector is RECORDED so zch2.3/zch2.4 can pick up generated content
  // without re-parsing, and it matches no real element here.
  if (c.pseudoElement !== undefined) return false;
  return true;
}

/** Same type AND namespace. An SVG <a> and an HTML <a> are different types,
 *  so a name-only comparison makes `:first-of-type` count across both. */
function sameType(a: HtmlElement, b: HtmlElement): boolean {
  return a.ns === b.ns && a.name === b.name;
}

function siblingSet(el: HtmlElement, axis: 'child' | 'of-type'): HtmlElement[] {
  const p = el.parent;
  if (p === null) return [el];
  const sibs = elementChildren(p);
  return axis === 'child' ? sibs : sibs.filter((s) => sameType(s, el));
}

function matchPseudo(p: Pseudo, el: HtmlElement, scope: HtmlElement | null): boolean {
  switch (p.kind) {
    // Recognised, and no static answer: :hover, :active, :focus, :target,
    // :visited. NOT the same as unsupported — see parsePseudo.
    case 'never': return false;
    // The document element: an element whose parent is the document itself.
    case 'root': return el.parent !== null && el.parent.kind === 'document';
    // No children AT ALL. A text node, even whitespace, makes it non-empty.
    case 'empty': return el.children.length === 0;
    case 'only': return siblingSet(el, p.axis).length === 1;
    case 'nth': {
      const set = siblingSet(el, p.axis);
      const at = set.indexOf(el);
      if (at < 0) return false;
      // 1-based, and from the end when the selector says so.
      const index = p.fromEnd ? set.length - at : at + 1;
      return nthMatches(p.a, p.b, index);
    }
    case 'link':
      return el.ns === 'html' && LINK_TYPES.has(el.name.toLowerCase())
        && el.attrs.get('href') !== undefined;
    // An element with NO language in scope matches no range, the wildcard
    // included: `*` means "any language", not "no language".
    case 'lang': {
      const tag = nodeLanguage(el);
      return tag !== undefined && p.ranges.some((r) => langMatches(tag, r));
    }
    // An unknown direction compares equal to nothing, which is Selectors 4's
    // never-matching rather than invalid — see parsePseudo.
    case 'dir': return nodeDirection(el) === p.value;
    case 'not': return !p.args.some((s) => matches(s, el, scope));
    case 'is':
    case 'where': return p.args.some((s) => matches(s, el, scope));
    // The anchor of the :has() we are inside. Unreachable from author text.
    case 'scope': return el === scope;
    case 'has': return p.args.some((s) => hasMatch(s, el));
    default: return false;
  }
}

// ---- complex matching ------------------------------------------------------

/** Match parts[i] against `el`, then everything to its left.
 *
 *  Right-to-left, with NO ancestors array: htmldom.ts carries parent pointers
 *  and says in its own header that zch2.2's selector matching is why.
 *
 *  `descendant` and `subsequent-sibling` BACKTRACK — in `a b c`, the nearest
 *  b-matching ancestor may have no `a` above it while a further one does.
 *  `child` and `next-sibling` have exactly one candidate. */
function matchFrom(
  sel: ComplexSelector, i: number, el: HtmlElement, scope: HtmlElement | null,
): boolean {
  if (!matchCompound(sel.parts[i] as Compound, el, scope)) return false;
  if (i === 0) return true;

  switch (sel.combinators[i - 1] as Combinator) {
    case 'child': {
      const p = parentElement(el);
      return p !== null && matchFrom(sel, i - 1, p, scope);
    }
    case 'descendant': {
      for (let p = parentElement(el); p !== null; p = parentElement(p)) {
        if (matchFrom(sel, i - 1, p, scope)) return true;
      }
      return false;
    }
    case 'next-sibling': {
      const prev = precedingSiblings(el)[0];
      return prev !== undefined && matchFrom(sel, i - 1, prev, scope);
    }
    case 'subsequent-sibling': {
      for (const prev of precedingSiblings(el)) {
        if (matchFrom(sel, i - 1, prev, scope)) return true;
      }
      return false;
    }
    default: return false;
  }
}

// ---- :has() ----------------------------------------------------------------

/** Every element strictly below `n`, in document order.
 *
 *  A generator rather than an array because `hasMatch` stops at the first
 *  candidate that works, and materializing a subtree it will abandon on the
 *  first element is the cost this pseudo-class is already expensive enough
 *  without. It reads `elementChildren`, so a template's `content` is not
 *  reachable — a template's content is not part of the document, and here
 *  that falls out of the shape rather than needing a rule.
 *
 *  Note, measured, and it is the redundant-defences trap: the anchor's own
 *  EXCLUSION is not enforced here. Yielding `n` itself as well reddens
 *  NOTHING, because matchFrom then walks up from the candidate and can never
 *  find the anchor above itself. `p:has(p)` is right either way, so do not
 *  read its test as covering this line. */
function* descendants(n: HtmlNode): Generator<HtmlElement> {
  for (const c of elementChildren(n)) {
    yield c;
    yield* descendants(c);
  }
}

/** Every following sibling ELEMENT and everything below it, in document
 *  order. Both sibling leads use this: `:has(+ p em)`'s subject is the `em`,
 *  which is not itself a sibling, so a candidate set of the siblings alone
 *  would find nothing. matchFrom is what then rejects the `~` matches for a
 *  `+` lead, by walking back to precedingSiblings[0]. */
function* followingSubtrees(el: HtmlElement): Generator<HtmlElement> {
  const p = el.parent;
  if (p === null) return;
  const sibs = elementChildren(p);
  for (let i = sibs.indexOf(el) + 1; i > 0 && i < sibs.length; i++) {
    const s = sibs[i] as HtmlElement;
    yield s;
    yield* descendants(s);
  }
}

/** Does `anchor` have a relative match for `sel`?
 *
 *  `sel.parts[0]` is the scope compound and `sel.combinators[0]` is the lead,
 *  so the whole job is picking a candidate set the subject could live in and
 *  letting matchFrom walk back to the anchor.
 *
 *  The lead narrows the candidates only as a COST measure — matchFrom rejects
 *  everything outside the subtree anyway, by failing to reach the anchor.
 *  Measured, and recorded because it means the narrowing is UNPINNED: widening
 *  the descendant lead to the whole document reddens NOTHING, the answers being
 *  identical. Only the SIBLING pool is load-bearing, and that one is a
 *  correctness rule rather than a cost one — a `+` or `~` subject is not below
 *  the anchor at all, so searching its subtree finds nothing whatever.
 *
 *  Cost, and it is the reason this pseudo-class was deferred out of zch2.2.2:
 *  csscascade.ts asks every rule about every element, so one :has() rule is
 *  O(n) per element and O(n²) over the document. Measured rather than guessed
 *  — see test/cssselect-has-cost.test.ts — and left uncached, so this module
 *  keeps the pure-leaf, no-hidden-state property its header claims. */
function hasMatch(sel: ComplexSelector, anchor: HtmlElement): boolean {
  const lead = sel.combinators[0] as Combinator;
  const pool = lead === 'child' || lead === 'descendant'
    ? descendants(anchor)
    : followingSubtrees(anchor);
  const last = sel.parts.length - 1;
  for (const cand of pool) {
    if (matchFrom(sel, last, cand, anchor)) return true;
  }
  return false;
}

/** Does `sel` match `el`? */
export function matches(
  sel: ComplexSelector, el: HtmlElement, scope: HtmlElement | null = null,
): boolean {
  return matchFrom(sel, sel.parts.length - 1, el, scope);
}

/** Every element under `root` matching any selector in `list`, in document
 *  order, each reported at most once.
 *
 *  Does NOT descend into a template's `content`: a template's content is not
 *  part of the document, so CSS must not match into it. */
export function selectAll(root: HtmlNode, list: SelectorList): HtmlElement[] {
  const out: HtmlElement[] = [];
  const visit = (n: HtmlNode): void => {
    if (n.kind === 'element' && list.some((s) => matches(s, n))) out.push(n);
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment') {
      for (const c of n.children) visit(c);
    }
  };
  visit(root);
  return out;
}

// ---- specificity -----------------------------------------------------------

/** Selectors 4 §17, as a TUPLE compared lexicographically rather than
 *  svgcss.ts's packed a * 10000 + b * 100 + c.
 *
 *  Packing needs a documented no-carry bound, which svgcss.ts duly carries. A
 *  tuple needs none, and `:is()`'s "take the maximum of the arguments" is then
 *  a plain lexicographic max rather than a claim about the packing preserving
 *  order. The cost is a comparator the cascade would have needed anyway to
 *  break ties on source order. */
export type Specificity = readonly [number, number, number];

export function compareSpecificity(a: Specificity, b: Specificity): number {
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function addSpec(a: Specificity, b: Specificity): Specificity {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function pseudoSpecificity(p: Pseudo): Specificity {
  switch (p.kind) {
    // :where() contributes NOTHING, whatever its arguments.
    case 'where': return [0, 0, 0];
    // The implicit anchor is not something the author wrote, so it weighs
    // nothing. Left to the default branch it would weigh a phantom class and
    // report `div:has(> p)` as [0, 1, 2] instead of [0, 0, 2].
    case 'scope': return [0, 0, 0];
    // :is(), :not() and :has() take their arguments' MAXIMUM, not their sum —
    // and the maximum is lexicographic, so one id beats ten classes.
    case 'is':
    case 'not':
    case 'has': {
      let best: Specificity = [0, 0, 0];
      for (const s of p.args) {
        const c = specificityOf(s);
        if (compareSpecificity(c, best) > 0) best = c;
      }
      return best;
    }
    // Every other pseudo-class weighs as a class, a recognised-but-never-
    // matching one included: its weight is observable through a rule that
    // shares its list.
    default: return [0, 1, 0];
  }
}

function compoundSpecificity(c: Compound): Specificity {
  let s: Specificity = [
    c.ids.length,
    c.classes.length + c.attrs.length,
    c.type === undefined ? 0 : 1,
  ];
  for (const p of c.pseudos) s = addSpec(s, pseudoSpecificity(p));
  // A pseudo-element weighs as a type.
  if (c.pseudoElement !== undefined) s = addSpec(s, [0, 0, 1]);
  return s;
}

export function specificityOf(sel: ComplexSelector): Specificity {
  let s: Specificity = [0, 0, 0];
  for (const c of sel.parts) s = addSpec(s, compoundSpecificity(c));
  return s;
}
