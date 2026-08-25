// CSS <style> support for SVG embedding (issue 1gg0.11). Pure: no Document, no
// PDF objects, no Paint -- selector syntax only. The cascade RESULT lives in
// svgstyle.ts; this module decides which declarations reach it.
//
// Matching runs as a whole-tree pre-pass rather than at draw time, because a
// <style> may appear after what it styles, combinators need an ancestor chain
// the walker does not carry, and <stop> elements are resolved from inside
// <defs> where none is reconstructible.
import type { XmlNode } from './xml.js';

export interface Declaration {
  prop: string;
  value: string;
  important: boolean;
}

export interface RawRule {
  selector: string;
  decls: Declaration[];
}

export interface ParseResult {
  rules: RawRule[];
  /** True when an at-rule was skipped: the caller reports the fidelity loss. */
  dropped: boolean;
}

/** Strip CSS block comments. Runs before anything else, so a brace inside a
 *  comment cannot close a rule early. */
function stripComments(s: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = s.indexOf('/*', i);
    if (start < 0) return out + s.slice(i);
    out += s.slice(i, start);
    const end = s.indexOf('*/', start + 2);
    if (end < 0) return out;                 // unterminated: drop the rest
    i = end + 2;
  }
}

/** Split declarations on ';', then on the first ':'. A declaration without a
 *  colon is discarded on its own, leaving its neighbours intact. */
function parseDecls(body: string): Declaration[] {
  const out: Declaration[] = [];
  for (const chunk of body.split(';')) {
    const i = chunk.indexOf(':');
    if (i < 0) continue;
    const prop = chunk.slice(0, i).trim().toLowerCase();
    let value = chunk.slice(i + 1).trim();
    if (prop === '' || value === '') continue;
    let important = false;
    const m = /!\s*important$/i.exec(value);
    if (m) {
      important = true;
      value = value.slice(0, m.index).trim();
    }
    if (value !== '') out.push({ prop, value, important });
  }
  return out;
}

/** Parse a stylesheet into selector/declaration blocks, skipping at-rules. */
export function parseBlocks(css: string): ParseResult {
  const s = stripComments(css);
  const rules: RawRule[] = [];
  let dropped = false;
  let i = 0;

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === '@') {
      dropped = true;
      // @import ends at the first semicolon; @media/@font-face at the matching
      // close brace. Whichever comes first decides which form this is.
      const semi = s.indexOf(';', i);
      const open = s.indexOf('{', i);
      if (open < 0 || (semi >= 0 && semi < open)) {
        i = semi < 0 ? s.length : semi + 1;
        continue;
      }
      let depth = 0;
      let j = open;
      for (; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}' && --depth === 0) { j++; break; }
      }
      i = j;
      continue;
    }

    const open = s.indexOf('{', i);
    if (open < 0) break;                     // trailing junk with no block
    const selector = s.slice(i, open).trim();
    let close = s.indexOf('}', open);
    if (close < 0) close = s.length;         // unterminated final rule
    const decls = parseDecls(s.slice(open + 1, close));
    if (selector !== '' && decls.length > 0) rules.push({ selector, decls });
    i = close + 1;
  }
  return { rules, dropped };
}

/** One compound selector: a type and/or id and/or classes, all of which must
 *  match the same element. `*` sets no constraint at all. */
export interface Compound {
  type?: string;
  id?: string;
  classes: string[];
}

export interface Selector {
  /** Leftmost first. Matching runs right-to-left over this. */
  parts: Compound[];
  /** combinators[i] joins parts[i] to parts[i + 1]. */
  combinators: ('descendant' | 'child')[];
}

/** Split a selector list on top-level commas. */
export function splitSelectorList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x !== '');
}

/** Parse one compound selector, or null when it uses syntax we do not support. */
function parseCompound(s: string): Compound | null {
  if (s === '') return null;
  if (s === '*') return { classes: [] };
  // Attribute selectors, pseudo-classes and pseudo-elements are unsupported.
  // The parse loop below rejects anything else that is not a type, .class or
  // #id, so this only needs to name the constructs worth failing fast on.
  if (/[[\]:()]/.test(s)) return null;

  const out: Compound = { classes: [] };
  const m = /^[A-Za-z_][\w-]*/.exec(s);
  let i = 0;
  if (m) { out.type = m[0]; i = m[0].length; }
  while (i < s.length) {
    const kind = s[i];
    if (kind !== '.' && kind !== '#') return null;
    const name = /^[\w-]+/.exec(s.slice(i + 1));
    if (!name) return null;
    if (kind === '.') out.classes.push(name[0]);
    else if (out.id !== undefined) return null;   // two ids cannot both match
    else out.id = name[0];
    i += 1 + name[0].length;
  }
  return out;
}

/** Parse one selector, or null when unsupported. A caller that gets null drops
 *  the WHOLE rule, as browsers do -- a half-applied rule is worse than none,
 *  because the half that applied is indistinguishable from a correct render. */
export function parseSelector(s: string): Selector | null {
  const src = s.trim();
  if (src === '') return null;
  if (/[+~]/.test(src)) return null;             // sibling combinators
  // Normalize `>` so splitting on whitespace finds it as its own token.
  const tokens = src.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return null;

  const parts: Compound[] = [];
  const combinators: ('descendant' | 'child')[] = [];
  let pendingChild = false;
  for (const t of tokens) {
    if (t === '>') {
      if (parts.length === 0 || pendingChild) return null;   // leading or doubled
      pendingChild = true;
      continue;
    }
    const c = parseCompound(t);
    if (!c) return null;
    if (parts.length > 0) combinators.push(pendingChild ? 'child' : 'descendant');
    pendingChild = false;
    parts.push(c);
  }
  if (pendingChild) return null;                 // trailing '>'
  return { parts, combinators };
}

/** CSS specificity packed as a * 10000 + b * 100 + c. No selector a real asset
 *  contains comes close to 100 of any one component, so this cannot carry. */
export function specificity(sel: Selector): number {
  let a = 0, b = 0, c = 0;
  for (const p of sel.parts) {
    if (p.id !== undefined) a++;
    b += p.classes.length;
    if (p.type !== undefined) c++;
  }
  return a * 10000 + b * 100 + c;
}

/** The element's class list, space-separated per SVG. */
function classList(n: XmlNode): string[] {
  const c = n.attrs.get('class');
  return c === undefined ? [] : c.trim().split(/\s+/).filter((x) => x !== '');
}

/** Match one compound against one element. Case-sensitive: SVG is XML. */
function matchCompound(c: Compound, n: XmlNode): boolean {
  if (c.type !== undefined && c.type !== n.name) return false;
  if (c.id !== undefined && c.id !== n.attrs.get('id')) return false;
  if (c.classes.length > 0) {
    const have = classList(n);
    for (const cl of c.classes) if (!have.includes(cl)) return false;
  }
  return true;
}

/** Match `sel.parts[i]` against `node`, then everything to its left against
 *  `ancestors` (outermost first, excluding `node`).
 *
 *  The descendant case BACKTRACKS: in `a b c`, the nearest b-matching ancestor
 *  may have no `a` above it while a further one does, so every candidate must
 *  be tried rather than only the nearest. */
function matchFrom(
  sel: Selector, i: number, node: XmlNode, ancestors: XmlNode[],
): boolean {
  if (!matchCompound(sel.parts[i], node)) return false;
  if (i === 0) return true;
  const comb = sel.combinators[i - 1];
  if (ancestors.length === 0) return false;
  if (comb === 'child')
    return matchFrom(sel, i - 1, ancestors[ancestors.length - 1], ancestors.slice(0, -1));
  for (let k = ancestors.length - 1; k >= 0; k--)
    if (matchFrom(sel, i - 1, ancestors[k], ancestors.slice(0, k))) return true;
  return false;
}

/** Does `sel` match `node`? `ancestors` is outermost-first, excluding `node`. */
export function matches(sel: Selector, node: XmlNode, ancestors: XmlNode[]): boolean {
  return matchFrom(sel, sel.parts.length - 1, node, ancestors);
}

/** The declarations in force on one element, already cascaded. */
export interface CssDecls {
  normal: Map<string, string>;
  important: Map<string, string>;
}

export type CssMap = Map<XmlNode, CssDecls>;

interface CompiledRule {
  sel: Selector;
  spec: number;
  order: number;
  decls: Declaration[];
}

export interface Stylesheet {
  rules: CompiledRule[];
  /** True when an at-rule was skipped or a rule was dropped as unparseable. */
  dropped: boolean;
}

/** Compile a stylesheet. A grouped selector expands to INDEPENDENT rules, each
 *  carrying its own specificity: `.a, #b { }` is two rules, not one at the
 *  higher, or `.a` would win against a competing `#c`. */
export function parseStylesheet(css: string): Stylesheet {
  const { rules: raw, dropped: atDropped } = parseBlocks(css);
  const rules: CompiledRule[] = [];
  let dropped = atDropped;
  let order = 0;
  for (const r of raw) {
    for (const one of splitSelectorList(r.selector)) {
      const sel = parseSelector(one);
      if (!sel) { dropped = true; continue; }
      rules.push({ sel, spec: specificity(sel), decls: r.decls, order: order++ });
    }
  }
  return { rules, dropped };
}

/** Concatenate every <style> element's text, in document order. A <style> whose
 *  `type` is present and not text/css is skipped and flagged. */
export function collectStyleText(root: XmlNode): { css: string; badType: boolean } {
  const parts: string[] = [];
  let badType = false;
  const walk = (n: XmlNode): void => {
    if (n.name === 'style') {
      const t = n.attrs.get('type');
      if (t !== undefined && t.trim().toLowerCase() !== 'text/css') badType = true;
      else parts.push(n.text);
      return;                                // a <style> has no element children
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return { css: parts.join('\n'), badType };
}

/** Resolve every element's declarations in one walk.
 *
 *  A pre-pass, not per-element work at draw time: a <style> may appear after
 *  what it styles, combinators need the ancestor chain, and <stop> elements are
 *  resolved by svggradient.ts from inside <defs> where no chain exists. */
export function resolveAll(root: XmlNode, sheet: Stylesheet): CssMap {
  const out: CssMap = new Map();
  if (sheet.rules.length === 0) return out;
  const ancestors: XmlNode[] = [];

  const visit = (n: XmlNode): void => {
    const hit: CompiledRule[] = [];
    for (const r of sheet.rules) if (matches(r.sel, n, ancestors)) hit.push(r);
    if (hit.length > 0) {
      // Weakest first, so later writes overwrite: specificity, then source order.
      hit.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
      const normal = new Map<string, string>();
      const important = new Map<string, string>();
      for (const r of hit)
        for (const d of r.decls)
          (d.important ? important : normal).set(d.prop, d.value);
      out.set(n, { normal, important });
    }
    ancestors.push(n);
    for (const c of n.children) visit(c);
    ancestors.pop();
  };
  visit(root);
  return out;
}
