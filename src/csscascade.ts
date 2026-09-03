/** The CSS cascade: collecting stylesheets, and deciding which declarations
 *  reach each element.
 *
 *  Invariant: a PURE LEAF. It imports the two parser modules, cssselect.js,
 *  cssprop.js, cssshorthand.js, cssua.js and htmldom.js for types. No
 *  Document, no PDF object, no `node:` import. It never throws: everything it
 *  cannot use is recorded on `unsupported` for zch2.7.
 *
 *  Invariant: it is PROPERTY-AGNOSTIC in the sense that matters — it consults
 *  PROPERTIES and SHORTHANDS for one question only, "is this name something we
 *  know", and never touches `compute` or `inherited`, and parses no values.
 *  That is what lets every rule below be tested from hand-written
 *  declarations, and it is why the property table can change without this
 *  module moving.
 *
 *  Invariant: shorthands expand HERE, before the sort, because the cascade
 *  sorts longhands only. `p { margin: 0; margin-top: 5px }` yields 5px and
 *  the reverse order yields 0; expanding after the sort yields 0 both times,
 *  which is a wrong answer indistinguishable from a right one.
 *
 *  Invariant: the collection walk does NOT descend into a <template>'s
 *  content. A template's content is not part of the document, so a <style>
 *  inside one styles nothing — the same structural rule selectAll follows. */

import {
  parseStylesheet, parseComponentValueList,
  parseDeclarationsFromValues, parseRulesFromValues,
} from './cssparse.js';
import type { CssAtRule, CssDeclaration, CssQualifiedRule, CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import { parseSelectorList, specificityOf, matches, compareSpecificity } from './cssselect.js';
import type { ComplexSelector, Specificity } from './cssselect.js';
import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';
import { PROPERTIES } from './cssprop.js';
import type { UnsupportedDeclaration } from './cssprop.js';
import { SHORTHANDS, expandShorthand } from './cssshorthand.js';
import { hasVar, isCustomProperty, longhandsOf } from './cssvar.js';
import type { DeclValue } from './cssvar.js';
import { UA_CSS } from './cssua.js';

/** The six cascade tiers, low to high. See `bySortKey` for why flattening
 *  origin, importance and element-attachment into one ordinal is the point
 *  rather than a shortcut. */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6;

export interface CompiledRule {
  sel: ComplexSelector;
  spec: Specificity;
  order: number;
  tier: Tier;
  /** Longhands, already expanded. A pending entry is a shorthand whose
   *  value carries a var() and cannot expand until an element's environment
   *  is known — see cssvar.ts. */
  decls: [string, DeclValue][];
}

export interface InlineDeclarations {
  normal: [string, DeclValue][];
  important: [string, DeclValue][];
}

export interface Collected {
  rules: CompiledRule[];
  inline: Map<HtmlElement, InlineDeclarations>;
  unsupported: UnsupportedDeclaration[];
}

const MEDIA_TYPES_WE_ARE = new Set(['print', 'all']);

/** Does this `@media` prelude apply to a print user agent?
 *
 *  Types only. A query carrying a FEATURE — detected structurally, as a `(`
 *  block, with no string matching anywhere — is non-matching and reported so
 *  the caller can record it. Evaluating a feature needs a viewport, which is
 *  the thing this module deliberately does not have. */
export function mediaMatches(prelude: CssValue[]): { ok: boolean; feature: boolean } {
  const queries: CssValue[][] = [[]];
  for (const v of prelude) {
    if ((v as CssToken).kind === 'comma') { queries.push([]); continue; }
    (queries[queries.length - 1] as CssValue[]).push(v);
  }

  let ok = false;
  let feature = false;
  for (const q of queries) {
    const t = q.filter((x) => (x as CssToken).kind !== 'whitespace');
    if (t.length === 0) continue;
    if (t.some((x) => (x as { kind: string }).kind === 'block')) {
      feature = true;
      continue;
    }
    let i = 0;
    let negate = false;
    const first = t[0] as CssToken;
    if (first.kind === 'ident') {
      const k = first.value.toLowerCase();
      if (k === 'only') i = 1;
      else if (k === 'not') { negate = true; i = 1; }
    }
    const typeTok = t[i] as CssToken | undefined;
    if (typeTok === undefined || typeTok.kind !== 'ident') continue;
    // Anything after the type is an `and`-joined feature we do not evaluate.
    if (t.length > i + 1) { feature = true; continue; }
    const hit = MEDIA_TYPES_WE_ARE.has(typeTok.value.toLowerCase());
    if (negate ? !hit : hit) ok = true;
  }
  return { ok, feature };
}

/** Render a value back to rough source text, for an `unsupported` entry. */
function valueText(v: CssValue[]): string {
  return v.map((x) => {
    const t = x as { kind: string; value?: unknown; unit?: string; name?: string };
    if (t.kind === 'whitespace') return ' ';
    if (t.kind === 'dimension') return `${String(t.value)}${String(t.unit)}`;
    if (t.kind === 'percentage') return `${String(t.value)}%`;
    if (t.kind === 'hash') return `#${String(t.value)}`;
    if (t.kind === 'string') return `"${String(t.value)}"`;
    if (t.kind === 'function') return `${String(t.name)}(...)`;
    if (t.kind === 'comma') return ',';
    if (t.kind === 'colon') return ':';
    return String(t.value ?? '');
  }).join('').trim();
}

/** One declaration to the longhands it sets, recording what it could not use. */
function toLonghands(
  d: CssDeclaration, el: HtmlElement | null, unsupported: UnsupportedDeclaration[],
): [string, DeclValue][] {
  // BEFORE the fold, and that is the whole reason the raw name is read first:
  // a custom property is the one name in CSS that is case-sensitive, so
  // --Foo and --foo are different properties.
  if (isCustomProperty(d.name)) return [[d.name, d.value]];

  const name = d.name.toLowerCase();       // cssparse.ts does NOT fold the name

  if (SHORTHANDS.has(name)) {
    // Checked BEFORE expandShorthand, which cannot read a raw var() and would
    // report the declaration unparsable. One pending per governed longhand,
    // re-expanded once the element's environment is known — so shorthands
    // still expand before the sort, which is this module's own invariant.
    if (hasVar(d.value)) {
      return longhandsOf(name).map(
        (k): [string, DeclValue] => [k, { pending: { shorthand: name, value: d.value } }],
      );
    }
    const ex = expandShorthand(name, d.value);
    if (ex === undefined) {
      unsupported.push({
        el, property: name, value: valueText(d.value), reason: 'unparsable-value',
      });
      return [];
    }
    return ex;
  }

  if (PROPERTIES.has(name)) return [[name, d.value]];

  unsupported.push({
    el, property: name, value: valueText(d.value), reason: 'unknown-property',
  });
  return [];
}

interface Walk {
  rules: CompiledRule[];
  unsupported: UnsupportedDeclaration[];
  order: { n: number };
}

/** Compile one rule list, recursing through matching `@media` blocks. */
function compileRules(
  rules: (CssAtRule | CssQualifiedRule | { kind: 'error'; code: string })[],
  normalTier: Tier, importantTier: Tier, w: Walk,
): void {
  for (const r of rules) {
    if (r.kind === 'error') continue;

    if (r.kind === 'at-rule') {
      if (r.name.toLowerCase() === 'media') {
        const m = mediaMatches(r.prelude);
        if (m.feature) {
          w.unsupported.push({
            el: null, property: '@media', value: valueText(r.prelude),
            reason: 'unsupported-media-feature',
          });
        }
        if (m.ok && r.block !== null) {
          compileRules(parseRulesFromValues(r.block), normalTier, importantTier, w);
        }
        continue;
      }
      w.unsupported.push({
        el: null, property: `@${r.name.toLowerCase()}`, value: valueText(r.prelude),
        reason: 'unsupported-at-rule',
      });
      continue;
    }

    // A grouped selector becomes INDEPENDENT rules, each carrying its own
    // specificity: `.a, #b { }` is two rules, not one at the higher, or `.a`
    // would win against a competing `#c`.
    const list = parseSelectorList(r.prelude);
    if (list === null) {
      w.unsupported.push({
        el: null, property: 'selector', value: valueText(r.prelude),
        reason: 'unparsable-value',
      });
      continue;
    }

    const normal: [string, DeclValue][] = [];
    const important: [string, DeclValue][] = [];
    for (const d of parseDeclarationsFromValues(r.block)) {
      if (d.kind !== 'declaration') continue;
      (d.important ? important : normal).push(...toLonghands(d, null, w.unsupported));
    }

    for (const sel of list) {
      const spec = specificityOf(sel);
      if (normal.length > 0) {
        w.rules.push({ sel, spec, order: w.order.n, tier: normalTier, decls: normal });
      }
      if (important.length > 0) {
        w.rules.push({ sel, spec, order: w.order.n, tier: importantTier, decls: important });
      }
    }
    w.order.n++;
  }
}

let uaCompiled: CompiledRule[] | null = null;

/** The UA sheet, compiled once. Lazy so a caller that never renders HTML
 *  pays nothing; memoized because it cannot change. */
function uaRules(): CompiledRule[] {
  if (uaCompiled !== null) return uaCompiled;
  const w: Walk = { rules: [], unsupported: [], order: { n: 0 } };
  compileRules(parseStylesheet(UA_CSS), 1, 6, w);
  uaCompiled = w.rules;
  return uaCompiled;
}

/** The text of a `<style>` element: its child text nodes, concatenated. */
function styleText(el: HtmlElement): string {
  return el.children
    .map((c) => (c.kind === 'text' ? c.data : ''))
    .join('');
}

export function collect(root: HtmlDocument): Collected {
  const w: Walk = { rules: [...uaRules()], unsupported: [], order: { n: 0 } };
  const inline = new Map<HtmlElement, InlineDeclarations>();
  const sheets: string[] = [];

  const visit = (n: HtmlNode): void => {
    if (n.kind === 'element') {
      if (n.ns === 'html' && n.name === 'style') {
        const type = n.attrs.get('type');
        if (type !== undefined && type.trim().toLowerCase() !== 'text/css') {
          w.unsupported.push({
            el: n, property: 'style', value: type, reason: 'unsupported-at-rule',
          });
        } else {
          sheets.push(styleText(n));
        }
        return;                              // a <style> has no element children
      }

      const style = n.attrs.get('style');
      if (style !== undefined && style.trim() !== '') {
        const normal: [string, DeclValue][] = [];
        const important: [string, DeclValue][] = [];
        for (const d of parseDeclarationsFromValues(parseComponentValueList(style))) {
          if (d.kind !== 'declaration') continue;
          (d.important ? important : normal).push(...toLonghands(d, n, w.unsupported));
        }
        if (normal.length > 0 || important.length > 0) {
          inline.set(n, { normal, important });
        }
      }
    }

    // NOT `n.content`: a template's content is not part of the document.
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment') {
      for (const c of n.children) visit(c);
    }
  };
  visit(root);

  // Author sheets are compiled AFTER the walk, because a <style> may appear
  // after what it styles — the same reason svgcss.ts makes a whole-tree
  // pre-pass. Order across sheets is document order, which `sheets` preserves.
  compileRules(parseStylesheet(sheets.join('\n')), 2, 4, w);

  return { rules: w.rules, inline, unsupported: w.unsupported };
}

export interface ElementDeclarations {
  /** The winner across all six tiers. Custom properties are in here too,
   *  under their raw case-sensitive names. */
  all: Map<string, DeclValue>;
  /** The winner among the UA tiers alone (1 and 6), which is what `revert`
   *  reverts TO. */
  ua: Map<string, DeclValue>;
}

/** A rule and an inline block reduced to one sortable shape. */
interface Candidate {
  tier: Tier;
  spec: Specificity;
  order: number;
  decls: [string, DeclValue][];
}

/** Sort ascending: tier, then specificity, then source order. Weakest first,
 *  so a later write simply overwrites — the shape svgcss.ts already uses.
 *
 *  The SIX TIERS are the point, not a shortcut. CSS Cascade 5 §6.4 sorts by
 *  origin and importance, then by context, then by whether a declaration is
 *  element-attached, then specificity, then order. With no user origin and no
 *  shadow context, the first and third steps flatten to one ordinal:
 *
 *    1  UA normal
 *    2  author normal, stylesheet
 *    3  author normal, style=
 *    4  author !important, stylesheet
 *    5  author !important, style=
 *    6  UA !important
 *
 *  The tempting shortcut — "a style= declaration has infinite specificity" —
 *  is RIGHT that style= beats any selector at equal importance and WRONG that
 *  a normal style= beats an !important stylesheet rule. Six tiers get both
 *  directions right by construction, and the two tests for them are written
 *  so that breaking either leaves the other green. */
function bySortKey(a: Candidate, b: Candidate): number {
  return (a.tier - b.tier) || compareSpecificity(a.spec, b.spec) || (a.order - b.order);
}

const NO_SPEC: Specificity = [0, 0, 0];

export function cascade(
  root: HtmlDocument, c: Collected,
): Map<HtmlElement, ElementDeclarations> {
  const out = new Map<HtmlElement, ElementDeclarations>();

  const visit = (n: HtmlNode): void => {
    if (n.kind === 'element') {
      const hits: Candidate[] = [];
      for (const r of c.rules) {
        if (matches(r.sel, n)) {
          hits.push({ tier: r.tier, spec: r.spec, order: r.order, decls: r.decls });
        }
      }
      const inline = c.inline.get(n);
      if (inline !== undefined) {
        // An element has at most one style= attribute, so specificity and
        // order can never separate two inline candidates; the tier does all
        // the work. Order is set past every rule so a tie cannot reorder it.
        if (inline.normal.length > 0) {
          hits.push({
            tier: 3, spec: NO_SPEC, order: Number.MAX_SAFE_INTEGER, decls: inline.normal,
          });
        }
        if (inline.important.length > 0) {
          hits.push({
            tier: 5, spec: NO_SPEC, order: Number.MAX_SAFE_INTEGER, decls: inline.important,
          });
        }
      }

      hits.sort(bySortKey);
      const all = new Map<string, DeclValue>();
      const ua = new Map<string, DeclValue>();
      for (const h of hits) {
        for (const [k, v] of h.decls) {
          all.set(k, v);
          // The UA winner is kept SEPARATELY rather than derived afterwards,
          // which is what makes `revert` a lookup instead of a second pass —
          // and two passes over one rule list are two things that can drift.
          if (h.tier === 1 || h.tier === 6) ua.set(k, v);
        }
      }
      out.set(n, { all, ua });
    }

    // Never `n.content`: a template's content is not part of the document.
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment') {
      for (const ch of n.children) visit(ch);
    }
  };
  visit(root);
  return out;
}
